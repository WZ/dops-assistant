/**
 * ServiceBrief aggregator — queries MCP providers in parallel, generates an AI
 * summary, and returns a ServiceBrief response for the Service Detail Overview tab.
 *
 * Features:
 *  - Per-section timeouts (3s)
 *  - In-memory cache with per-section TTLs and stale-while-revalidate
 *  - In-flight dedup (concurrent callers share the same Promise)
 *  - Graceful degradation (each section independent)
 */

import { generateText, type LanguageModel } from "ai";
import pino from "pino";
import { getToolsByRole, type MastraProvider } from "../mcp/provider.js";
import { MAX_CACHE_ENTRIES } from "../constants.js";
import type { ServiceConfig } from "../config/schema.js";
import { inferDependencyGraph } from "./dependency-graph.js";
import type { ServiceHealthPoller, HealthStatus } from "./service-health-poller.js";
import type {
  ServiceBrief,
  ChangesSection,
  InfrastructureSection,
  BriefDependencyNode,
  BriefDependencyEdge,
  AISummary,
  ContainerStatus,
  K8sEvent,
  Deployment,
  MergeRequest,
} from "../types/service-brief.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

// ── Public deps interface ────────────────────────────────────────────────────

export interface ServiceBriefDeps {
  providers: MastraProvider[];
  services: ServiceConfig[];
  healthPoller?: ServiceHealthPoller;
  llmModel?: LanguageModel;
}

// ── Cache ────────────────────────────────────────────────────────────────────

type SectionName = "changes" | "infrastructure" | "dependencies" | "summary";

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

/** TTLs in milliseconds per section */
const SECTION_TTL: Record<SectionName, number> = {
  dependencies: 5 * 60_000,     // 5 min
  infrastructure: 30_000,       // 30 sec
  changes: 2 * 60_000,          // 2 min
  summary: 2 * 60_000,          // 2 min
};

/** Maximum staleness before force-refresh (10 minutes) */
const MAX_STALE_AGE = 10 * 60_000;

/** Per-section timeout for MCP calls */
const SECTION_TIMEOUT_MS = 3_000;


const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<ServiceBrief>>();

function cacheKey(service: string, section: SectionName): string {
  return `${service}:${section}`;
}

function getCached<T>(service: string, section: SectionName): { data: T; status: "ok" | "stale" } | null {
  const entry = cache.get(cacheKey(service, section)) as CacheEntry<T> | undefined;
  if (!entry) return null;

  const age = Date.now() - entry.fetchedAt;
  if (age <= SECTION_TTL[section]) {
    return { data: entry.data, status: "ok" };
  }
  if (age <= MAX_STALE_AGE) {
    return { data: entry.data, status: "stale" };
  }
  // Beyond max stale age — treat as miss
  cache.delete(cacheKey(service, section));
  return null;
}

function setCache<T>(service: string, section: SectionName, data: T): void {
  cache.set(cacheKey(service, section), { data, fetchedAt: Date.now() });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

// ── Timeout helper ───────────────────────────────────────────────────────────

/**
 * Wraps a promise with a per-section timeout. Rejects with a descriptive
 * error if the promise does not settle within `ms` milliseconds.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// ── Tool finder helpers ──────────────────────────────────────────────────────

type ExecutableTool = { execute: (args: Record<string, unknown>) => Promise<unknown> };

/**
 * Find a tool from a role-based tool map by matching keywords against tool names
 * and descriptions. Returns the first match or null.
 */
function findTool(
  tools: Record<string, unknown>,
  keywords: string[],
): ExecutableTool | null {
  for (const [name, tool] of Object.entries(tools)) {
    const lower = name.toLowerCase();
    const desc = ((tool as { description?: string }).description ?? "").toLowerCase();
    if (keywords.some(kw => lower.includes(kw) || desc.includes(kw))) {
      return tool as ExecutableTool;
    }
  }
  return null;
}

/**
 * Parse MCP tool result — handles the MCP content-wrapped format.
 */
function parseMcpResult(raw: unknown): unknown {
  if (!raw) return null;
  // MCP content-wrapped format: { content: [{ type: "text", text: "..." }] }
  if (typeof raw === "object" && raw !== null && "content" in raw) {
    const content = (raw as { content: unknown[] }).content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as { type?: string; text?: string };
      if (first.type === "text" && typeof first.text === "string") {
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      }
    }
  }
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

// ── MCP output shape coercers ────────────────────────────────────────────────
//
// MCP tools may return malformed or partially-missing data. These helpers
// coerce unknown values into well-typed shapes with sensible defaults so the
// rest of the code never sees NaN / undefined in numeric or string fields.

function coerceContainer(c: unknown): ContainerStatus {
  const obj = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  return {
    name: String(obj.name ?? "unknown"),
    cpuUsage: String(obj.cpuUsage ?? "0"),
    cpuLimit: String(obj.cpuLimit ?? "0"),
    memUsage: String(obj.memUsage ?? "0"),
    memLimit: String(obj.memLimit ?? "0"),
    restarts: Number(obj.restarts) || 0,
    lastRestartReason: obj.lastRestartReason ? String(obj.lastRestartReason) : undefined,
  };
}

function coerceEvent(e: unknown): K8sEvent {
  const obj = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
  return {
    type: String(obj.type ?? "Warning") as K8sEvent["type"],
    reason: String(obj.reason ?? "Unknown"),
    message: String(obj.message ?? ""),
    firstSeen: String(obj.firstSeen ?? new Date().toISOString()),
    lastSeen: String(obj.lastSeen ?? new Date().toISOString()),
    count: Number(obj.count) || 1,
  };
}

function coerceDeployment(d: unknown): Deployment {
  const obj = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
  return {
    ref: String(obj.ref ?? "unknown"),
    pipelineId: Number(obj.pipelineId) || 0,
    pipelineStatus: String(obj.pipelineStatus ?? "unknown"),
    environment: String(obj.environment ?? "unknown"),
    deployedAt: String(obj.deployedAt ?? new Date().toISOString()),
    deployedBy: String(obj.deployedBy ?? "unknown"),
  };
}

function coerceMergeRequest(mr: unknown): MergeRequest {
  const obj = (mr && typeof mr === "object" ? mr : {}) as Record<string, unknown>;
  return {
    iid: Number(obj.iid) || 0,
    title: String(obj.title ?? ""),
    mergedAt: String(obj.mergedAt ?? new Date().toISOString()),
    mergedBy: String(obj.mergedBy ?? "unknown"),
    filesChanged: Number(obj.filesChanged) || 0,
    webUrl: String(obj.webUrl ?? ""),
  };
}

// ── Section fetchers ─────────────────────────────────────────────────────────
//
// Each fetcher owns its own cache check. It returns:
//   - cached data (if fresh)           → no MCP call
//   - fresh data (after MCP call)      → updates cache
//   - null (if no tools configured)    → outer code marks section "unconfigured"
//   - throws (if getToolsByRole fails or tool call fails hard) → outer code marks "error"
//
// This lets the outer Promise.allSettled always fan out all 3 in parallel.

async function fetchChanges(
  serviceName: string,
  providers: MastraProvider[],
): Promise<ChangesSection | null> {
  // Check cache first
  const cached = getCached<ChangesSection>(serviceName, "changes");
  if (cached && cached.status === "ok") return cached.data;

  // getToolsByRole is allowed to throw — callers treat that as "error" (not "unconfigured")
  const tools = await getToolsByRole(providers, "changes") as Record<string, unknown>;

  if (Object.keys(tools).length === 0) return null; // unconfigured

  // Look for deployment/pipeline tools
  const deployTool = findTool(tools, ["deployment", "pipeline", "deploy"]);
  const mrTool = findTool(tools, ["merge_request", "merge-request", "mr_list", "list_mr"]);

  const result: ChangesSection = {
    deployments: [],
    mergeRequests: [],
    configChanges: [],
  };

  if (deployTool) {
    try {
      // TODO: wire gitlabProject from ServiceConfig for project path resolution
      const raw = await withTimeout(
        deployTool.execute({ service: serviceName, limit: 5 }),
        SECTION_TIMEOUT_MS,
        "fetchChanges:deployments",
      );
      const parsed = parseMcpResult(raw);
      if (Array.isArray(parsed)) {
        result.deployments = parsed.map(coerceDeployment);
      }
    } catch (err) {
      logger.debug({ err, service: serviceName }, "service-brief: deployment fetch failed");
    }
  }

  if (mrTool) {
    try {
      const raw = await withTimeout(
        mrTool.execute({ service: serviceName, limit: 5, state: "merged" }),
        SECTION_TIMEOUT_MS,
        "fetchChanges:mergeRequests",
      );
      const parsed = parseMcpResult(raw);
      if (Array.isArray(parsed)) {
        result.mergeRequests = parsed.map(coerceMergeRequest);
      }
    } catch (err) {
      logger.debug({ err, service: serviceName }, "service-brief: MR fetch failed");
    }
  }

  setCache(serviceName, "changes", result);
  return result;
}

async function fetchInfrastructure(
  serviceName: string,
  providers: MastraProvider[],
): Promise<InfrastructureSection | null> {
  // Check cache first
  const cached = getCached<InfrastructureSection>(serviceName, "infrastructure");
  if (cached && cached.status === "ok") return cached.data;

  // getToolsByRole is allowed to throw — callers treat that as "error" (not "unconfigured")
  const tools = await getToolsByRole(providers, "infrastructure") as Record<string, unknown>;

  if (Object.keys(tools).length === 0) return null; // unconfigured

  // Look for pods/workload tool
  const podTool = findTool(tools, ["pod", "workload", "deployment", "describe", "resource"]);
  if (!podTool) return null;

  // TODO: namespace should come from ServiceConfig, not hardcoded
  const raw = await withTimeout(
    podTool.execute({ service: serviceName, namespace: "default" }),
    SECTION_TIMEOUT_MS,
    "fetchInfrastructure",
  );
  const parsed = parseMcpResult(raw);
  if (parsed && typeof parsed === "object") {
    // Attempt to coerce into InfrastructureSection shape
    const data = parsed as Record<string, unknown>;
    const result: InfrastructureSection = {
      workloadType: (data.workloadType as string) ?? "Deployment",
      replicas: (data.replicas as InfrastructureSection["replicas"]) ?? { desired: 0, ready: 0, available: 0 },
      containers: Array.isArray(data.containers) ? data.containers.map(coerceContainer) : [],
      recentEvents: (() => { const evts = data.recentEvents ?? data.events; return Array.isArray(evts) ? (evts as unknown[]).map(coerceEvent) : []; })(),
    };
    setCache(serviceName, "infrastructure", result);
    return result;
  }
  return null;
}

async function fetchDependencies(
  serviceName: string,
  services: ServiceConfig[],
  healthPoller?: ServiceHealthPoller,
): Promise<{ nodes: BriefDependencyNode[]; edges: BriefDependencyEdge[]; source: "inferred" }> {
  // Check cache first
  const cached = getCached<{ nodes: BriefDependencyNode[]; edges: BriefDependencyEdge[]; source: "inferred" }>(serviceName, "dependencies");
  if (cached && cached.status === "ok") return cached.data;

  const graph = inferDependencyGraph(services);

  // Filter to just the requested service and its neighbors
  const related = new Set<string>([serviceName]);
  for (const edge of graph.edges) {
    if (edge.source === serviceName) related.add(edge.target);
    if (edge.target === serviceName) related.add(edge.source);
  }

  const filteredNodes = graph.nodes.filter(n => related.has(n.id));
  const filteredEdges = graph.edges.filter(e => related.has(e.source) && related.has(e.target));

  // Enrich with health status from the poller
  if (healthPoller) {
    const healthMap = healthPoller.getHealth();
    for (const node of filteredNodes) {
      const status = healthMap.get(node.name);
      if (status) {
        // Map HealthStatus → BriefDependencyNode status
        const statusMap: Record<HealthStatus, BriefDependencyNode["status"]> = {
          healthy: "healthy",
          degraded: "degraded",
          down: "unhealthy",
          unknown: "unknown",
        };
        node.status = statusMap[status];
      }
    }
  }

  const result = { nodes: filteredNodes, edges: filteredEdges, source: "inferred" as const };
  setCache(serviceName, "dependencies", result);
  return result;
}

// ── Prompt sanitization ──────────────────────────────────────────────────────

/** Strip control characters and truncate to prevent prompt injection. */
function sanitizeForPrompt(s: string): string {
  return s.replace(/[\x00-\x1f]/g, "").slice(0, 200);
}

// ── AI Summary ───────────────────────────────────────────────────────────────

async function generateSummary(
  serviceName: string,
  changes: ChangesSection | null,
  infra: InfrastructureSection | null,
  deps: { nodes: BriefDependencyNode[]; edges: BriefDependencyEdge[] } | null,
  llmModel: LanguageModel,
): Promise<AISummary | null> {
  const parts: string[] = [];

  if (changes) {
    const deployCount = changes.deployments.length;
    const mrCount = changes.mergeRequests.length;
    parts.push(`Recent changes: ${deployCount} deployment(s), ${mrCount} merge request(s).`);
    if (deployCount > 0) {
      const latest = changes.deployments[0];
      parts.push(`Latest deploy: ref=${sanitizeForPrompt(latest.ref)}, status=${sanitizeForPrompt(latest.pipelineStatus)}, at=${sanitizeForPrompt(latest.deployedAt)}.`);
    }
  }

  if (infra) {
    const { replicas, containers, recentEvents } = infra;
    // Only include infra data in the prompt when it looks like real data — not
    // default zeros from a "service not found" MCP response.
    const hasRealData = replicas.desired > 0 || containers.length > 0 || recentEvents.length > 0;
    if (hasRealData) {
      parts.push(`Infrastructure: ${replicas.ready}/${replicas.desired} replicas ready, ${containers.length} container(s).`);
      const restarts = containers.reduce((sum, c) => sum + c.restarts, 0);
      if (restarts > 0) parts.push(`Total container restarts: ${restarts}.`);
      const warnings = recentEvents.filter(e => e.type === "Warning");
      if (warnings.length > 0) parts.push(`Warning events: ${warnings.length}.`);
    }
  }

  if (deps && deps.nodes.length > 0) {
    const unhealthy = deps.nodes.filter(n => n.status === "unhealthy" || n.status === "degraded");
    parts.push(`Dependency graph: ${deps.nodes.length} node(s), ${deps.edges.length} edge(s).`);
    if (unhealthy.length > 0) {
      parts.push(`Unhealthy/degraded dependencies: ${unhealthy.map(n => sanitizeForPrompt(n.name)).join(", ")}.`);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  const { text } = await generateText({
    model: llmModel,
    system: `You are a DevOps assistant. Given data about a service, write a 2-3 sentence summary that correlates recent changes with current health status. Be concise and actionable. Focus on what an on-call engineer needs to know right now. Output plain text only — no markdown, no bold, no asterisks, no bullet points, no formatting.`,
    prompt: `Service: ${sanitizeForPrompt(serviceName)}\n\n${parts.join("\n")}`,
    temperature: 0,
  });

  return { text: text.trim() };
}

// ── Main aggregator ──────────────────────────────────────────────────────────

export async function buildServiceBrief(
  serviceName: string,
  deps: ServiceBriefDeps,
): Promise<ServiceBrief> {
  // In-flight dedup — share the same Promise for concurrent callers
  const existing = inflight.get(serviceName);
  if (existing) return existing;

  const promise = doBuildServiceBrief(serviceName, deps);
  inflight.set(serviceName, promise);

  try {
    return await promise;
  } finally {
    inflight.delete(serviceName);
  }
}

async function doBuildServiceBrief(
  serviceName: string,
  deps: ServiceBriefDeps,
): Promise<ServiceBrief> {
  const { providers, services, healthPoller, llmModel } = deps;

  const errors: string[] = [];
  const sections: ServiceBrief["sections"] = {
    summary: { status: "unconfigured" },
    changes: { status: "unconfigured" },
    infrastructure: { status: "unconfigured" },
    dependencies: { status: "unconfigured" },
  };

  // ── Snapshot stale cache before fetching (for stale-while-revalidate) ──────
  //
  // Each fetcher owns its own fresh-cache check. We read stale entries here
  // only to return them as a fallback while background revalidation runs.

  const staleChanges = getCached<ChangesSection>(serviceName, "changes");
  const staleInfra = getCached<InfrastructureSection>(serviceName, "infrastructure");
  const staleDeps = getCached<{ nodes: BriefDependencyNode[]; edges: BriefDependencyEdge[]; source: "inferred" }>(serviceName, "dependencies");
  const staleSummary = getCached<AISummary>(serviceName, "summary");

  // If every section has a fresh cache hit, skip all fetches and return immediately.
  if (
    staleChanges?.status === "ok" &&
    staleInfra?.status === "ok" &&
    staleDeps?.status === "ok" &&
    staleSummary?.status === "ok"
  ) {
    return {
      summary: staleSummary.data,
      changes: staleChanges.data,
      infrastructure: staleInfra.data,
      dependencies: staleDeps.data,
      sections: {
        summary: { status: "ok", fetchedAt: Date.now() },
        changes: { status: "ok", fetchedAt: Date.now() },
        infrastructure: { status: "ok", fetchedAt: Date.now() },
        dependencies: { status: "ok", fetchedAt: Date.now() },
      },
      errors: [],
    };
  }

  // ── Conditional parallel fan-out ──────────────────────────────────────────
  //
  // Fan out all 3 sections via Promise.allSettled. Cache-hit sections resolve
  // immediately; stale/missing sections fetch from MCP. For stale sections we
  // also fire a background refresh so the caller gets stale data immediately
  // while revalidation runs in the background.

  type DepsResult = { nodes: BriefDependencyNode[]; edges: BriefDependencyEdge[]; source: "inferred" };

  // Background refresh for stale sections — fire-and-forget
  if (staleChanges?.status === "stale") {
    void fetchChanges(serviceName, providers).catch(err =>
      logger.debug({ err, service: serviceName }, "service-brief: background changes refresh failed"),
    );
  }
  if (staleInfra?.status === "stale") {
    void fetchInfrastructure(serviceName, providers).catch(err =>
      logger.debug({ err, service: serviceName }, "service-brief: background infrastructure refresh failed"),
    );
  }
  if (staleDeps?.status === "stale") {
    void fetchDependencies(serviceName, services, healthPoller).catch(err =>
      logger.debug({ err, service: serviceName }, "service-brief: background dependencies refresh failed"),
    );
  }

  // Foreground: only fetch sections that have no usable cache (miss or max-stale exceeded)
  const needChanges = !staleChanges;
  const needInfra = !staleInfra;
  const needDeps = !staleDeps;

  let changesData: ChangesSection | null = staleChanges?.data ?? null;
  let infraData: InfrastructureSection | null = staleInfra?.data ?? null;
  let depsData: DepsResult | null = staleDeps?.data ?? null;

  // Populate stale section statuses
  if (staleChanges) sections.changes = { status: staleChanges.status === "stale" ? "stale" : "ok", fetchedAt: Date.now() };
  if (staleInfra) sections.infrastructure = { status: staleInfra.status === "stale" ? "stale" : "ok", fetchedAt: Date.now() };
  if (staleDeps) sections.dependencies = { status: staleDeps.status === "stale" ? "stale" : "ok", fetchedAt: Date.now() };

  // Always fan out all 3 via Promise.allSettled — each fetcher returns cached data
  // if fresh, or makes an MCP call if not.
  const [changesResult, infraResult, depsResult] = await Promise.allSettled([
    needChanges ? fetchChanges(serviceName, providers) : Promise.resolve(changesData),
    needInfra ? fetchInfrastructure(serviceName, providers) : Promise.resolve(infraData),
    needDeps ? fetchDependencies(serviceName, services, healthPoller) : Promise.resolve(depsData),
  ]);

  // Process changes result
  if (needChanges) {
    if (changesResult.status === "fulfilled") {
      changesData = changesResult.value;
      if (changesData !== null) {
        sections.changes = { status: "ok", fetchedAt: Date.now() };
      } else {
        sections.changes = { status: "unconfigured" };
      }
    } else {
      const msg = changesResult.reason instanceof Error ? changesResult.reason.message : String(changesResult.reason);
      errors.push(`changes: ${msg}`);
      sections.changes = { status: "error", error: msg };
      logger.debug({ err: changesResult.reason, service: serviceName }, "service-brief: changes fetch failed");
    }
  }

  // Process infrastructure result
  if (needInfra) {
    if (infraResult.status === "fulfilled") {
      infraData = infraResult.value;
      if (infraData !== null) {
        sections.infrastructure = { status: "ok", fetchedAt: Date.now() };
      } else {
        sections.infrastructure = { status: "unconfigured" };
      }
    } else {
      const msg = infraResult.reason instanceof Error ? infraResult.reason.message : String(infraResult.reason);
      errors.push(`infrastructure: ${msg}`);
      sections.infrastructure = { status: "error", error: msg };
      logger.debug({ err: infraResult.reason, service: serviceName }, "service-brief: infrastructure fetch failed");
    }
  }

  // Process dependencies result
  if (needDeps) {
    if (depsResult.status === "fulfilled") {
      depsData = depsResult.value;
      if (depsData !== null) {
        sections.dependencies = { status: "ok", fetchedAt: Date.now() };
      } else {
        sections.dependencies = { status: "unconfigured" };
      }
    } else {
      const msg = depsResult.reason instanceof Error ? depsResult.reason.message : String(depsResult.reason);
      errors.push(`dependencies: ${msg}`);
      sections.dependencies = { status: "error", error: msg };
      logger.debug({ err: depsResult.reason, service: serviceName }, "service-brief: dependencies fetch failed");
    }
  }

  // ── AI Summary ──────────────────────────────────────────────────────────

  let summaryData: AISummary | null = staleSummary?.data ?? null;

  if (staleSummary?.status === "stale" && llmModel) {
    // Return stale summary immediately, refresh in background
    sections.summary = { status: "stale", fetchedAt: Date.now() };
    void generateSummary(serviceName, changesData, infraData, depsData, llmModel)
      .then(result => { if (result) setCache(serviceName, "summary", result); })
      .catch(err => logger.debug({ err, service: serviceName }, "service-brief: background summary refresh failed"));
  } else if (!staleSummary && llmModel) {
    // No cached summary — generate synchronously
    try {
      summaryData = await generateSummary(
        serviceName,
        changesData,
        infraData,
        depsData,
        llmModel,
      );
      if (summaryData) {
        setCache(serviceName, "summary", summaryData);
        sections.summary = { status: "ok", fetchedAt: Date.now() };
      } else {
        sections.summary = { status: "unconfigured" };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`summary: ${msg}`);
      sections.summary = { status: "error", error: msg };
    }
  } else if (staleSummary?.status === "ok") {
    sections.summary = { status: "ok", fetchedAt: Date.now() };
  }

  return {
    summary: summaryData,
    changes: changesData,
    infrastructure: infraData,
    dependencies: depsData,
    sections,
    errors,
  };
}

// ── Cache management (exported for testing) ──────────────────────────────────

/** Clear all cached entries (useful in tests). */
export function clearBriefCache(): void {
  cache.clear();
  inflight.clear();
}

/** Manually set a cache entry (useful in tests). */
export function setBriefCacheEntry<T>(service: string, section: SectionName, data: T, fetchedAt?: number): void {
  cache.set(cacheKey(service, section), { data, fetchedAt: fetchedAt ?? Date.now() });
}

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
import type { ServiceConfig } from "../config/schema.js";
import type { ServiceHealthPoller, HealthStatus } from "./service-health-poller.js";
import type {
  ServiceBrief,
  ChangesSection,
  InfrastructureSection,
  BriefDependencyNode,
  BriefDependencyEdge,
  SectionStatus,
  AISummary,
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
}

// ── Timeout helper ───────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms),
    ),
  ]);
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

// ── Section fetchers ─────────────────────────────────────────────────────────

async function fetchChanges(
  serviceName: string,
  providers: MastraProvider[],
): Promise<ChangesSection | null> {
  let tools: Record<string, unknown>;
  try {
    tools = await getToolsByRole(providers, "changes") as Record<string, unknown>;
  } catch {
    return null;
  }

  if (Object.keys(tools).length === 0) return null;

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
      const raw = await withTimeout(
        deployTool.execute({ service: serviceName, limit: 5 }),
        SECTION_TIMEOUT_MS,
        "fetchChanges:deployments",
      );
      const parsed = parseMcpResult(raw);
      if (Array.isArray(parsed)) {
        result.deployments = parsed;
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
        result.mergeRequests = parsed;
      }
    } catch (err) {
      logger.debug({ err, service: serviceName }, "service-brief: MR fetch failed");
    }
  }

  return result;
}

async function fetchInfrastructure(
  serviceName: string,
  providers: MastraProvider[],
): Promise<InfrastructureSection | null> {
  let tools: Record<string, unknown>;
  try {
    tools = await getToolsByRole(providers, "infrastructure") as Record<string, unknown>;
  } catch {
    return null;
  }

  if (Object.keys(tools).length === 0) return null;

  // Look for pods/workload tool
  const podTool = findTool(tools, ["pod", "workload", "deployment", "describe", "resource"]);
  if (!podTool) return null;

  try {
    const raw = await withTimeout(
      podTool.execute({ service: serviceName, namespace: "default" }),
      SECTION_TIMEOUT_MS,
      "fetchInfrastructure",
    );
    const parsed = parseMcpResult(raw);
    if (parsed && typeof parsed === "object") {
      // Attempt to coerce into InfrastructureSection shape
      const data = parsed as Record<string, unknown>;
      return {
        workloadType: (data.workloadType as string) ?? "Deployment",
        replicas: (data.replicas as InfrastructureSection["replicas"]) ?? { desired: 0, ready: 0, available: 0 },
        containers: Array.isArray(data.containers) ? data.containers : [],
        recentEvents: Array.isArray(data.recentEvents ?? data.events) ? (data.recentEvents ?? data.events) as InfrastructureSection["recentEvents"] : [],
      };
    }
    return null;
  } catch (err) {
    logger.debug({ err, service: serviceName }, "service-brief: infrastructure fetch failed");
    return null;
  }
}

/**
 * Infer service dependency graph from service registry data.
 * Extracted from routes.ts inferDependencyGraph — uses metric queries and log labels
 * to detect relationships between services.
 */
export function inferDependencyGraph(
  services: ServiceConfig[],
): { nodes: BriefDependencyNode[]; edges: BriefDependencyEdge[] } {
  const nodes: BriefDependencyNode[] = services.map(s => ({
    id: s.name,
    name: s.name,
    type: "service" as const,
    status: "unknown" as const,
  }));

  const edges: BriefDependencyEdge[] = [];
  const serviceNames = new Set(services.map(s => s.name));

  for (const svc of services) {
    // Check if any metric queries reference other services by name
    for (const metric of svc.metrics) {
      for (const otherName of serviceNames) {
        if (otherName === svc.name) continue;
        if (metric.query.includes(otherName) || metric.query.includes(otherName.replace(/-/g, "_"))) {
          if (!edges.some(e => e.source === svc.name && e.target === otherName)) {
            edges.push({ source: svc.name, target: otherName, label: "metrics" });
          }
        }
      }
    }

    // Check log labels for service references
    const logLabelValues = Object.values(svc.logLabels ?? {});
    for (const val of logLabelValues) {
      for (const otherName of serviceNames) {
        if (otherName === svc.name) continue;
        if (val.includes(otherName)) {
          if (!edges.some(e => e.source === svc.name && e.target === otherName)) {
            edges.push({ source: svc.name, target: otherName, label: "logs" });
          }
        }
      }
    }
  }

  return { nodes, edges };
}

async function fetchDependencies(
  serviceName: string,
  services: ServiceConfig[],
  healthPoller?: ServiceHealthPoller,
): Promise<{ nodes: BriefDependencyNode[]; edges: BriefDependencyEdge[]; source: "inferred" }> {
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

  return { nodes: filteredNodes, edges: filteredEdges, source: "inferred" as const };
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
      parts.push(`Latest deploy: ref=${latest.ref}, status=${latest.pipelineStatus}, at=${latest.deployedAt}.`);
    }
  }

  if (infra) {
    const { replicas, containers, recentEvents } = infra;
    parts.push(`Infrastructure: ${replicas.ready}/${replicas.desired} replicas ready, ${containers.length} container(s).`);
    const restarts = containers.reduce((sum, c) => sum + c.restarts, 0);
    if (restarts > 0) parts.push(`Total container restarts: ${restarts}.`);
    const warnings = recentEvents.filter(e => e.type === "Warning");
    if (warnings.length > 0) parts.push(`Warning events: ${warnings.length}.`);
  }

  if (deps && deps.nodes.length > 0) {
    const unhealthy = deps.nodes.filter(n => n.status === "unhealthy" || n.status === "degraded");
    parts.push(`Dependency graph: ${deps.nodes.length} node(s), ${deps.edges.length} edge(s).`);
    if (unhealthy.length > 0) {
      parts.push(`Unhealthy/degraded dependencies: ${unhealthy.map(n => n.name).join(", ")}.`);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  const { text } = await generateText({
    model: llmModel,
    system: `You are a DevOps assistant. Given data about a service, write a 2-3 sentence summary that correlates recent changes with current health status. Be concise and actionable. Focus on what an on-call engineer needs to know right now.`,
    prompt: `Service: ${serviceName}\n\n${parts.join("\n")}`,
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

  // ── Check cache per section, with stale-while-revalidate ──────────────

  let changesData: ChangesSection | null = null;
  let infraData: InfrastructureSection | null = null;
  let depsData: { nodes: BriefDependencyNode[]; edges: BriefDependencyEdge[]; source: "inferred" } | null = null;

  const cachedChanges = getCached<ChangesSection>(serviceName, "changes");
  const cachedInfra = getCached<InfrastructureSection>(serviceName, "infrastructure");
  const cachedDeps = getCached<{ nodes: BriefDependencyNode[]; edges: BriefDependencyEdge[]; source: "inferred" }>(serviceName, "dependencies");

  let needFetchChanges = !cachedChanges || cachedChanges.status === "stale";
  let needFetchInfra = !cachedInfra || cachedInfra.status === "stale";
  let needFetchDeps = !cachedDeps || cachedDeps.status === "stale";

  // Use cached data if available (even stale)
  if (cachedChanges) {
    changesData = cachedChanges.data;
    sections.changes = { status: cachedChanges.status === "stale" ? "stale" : "ok", fetchedAt: Date.now() };
  }
  if (cachedInfra) {
    infraData = cachedInfra.data;
    sections.infrastructure = { status: cachedInfra.status === "stale" ? "stale" : "ok", fetchedAt: Date.now() };
  }
  if (cachedDeps) {
    depsData = cachedDeps.data;
    sections.dependencies = { status: cachedDeps.status === "stale" ? "stale" : "ok", fetchedAt: Date.now() };
  }

  // If all sections are fresh from cache, check summary cache too
  if (!needFetchChanges && !needFetchInfra && !needFetchDeps) {
    const cachedSummary = getCached<AISummary>(serviceName, "summary");
    if (cachedSummary && cachedSummary.status === "ok") {
      return {
        summary: cachedSummary.data,
        changes: changesData,
        infrastructure: infraData,
        dependencies: depsData,
        sections: {
          ...sections,
          summary: { status: "ok", fetchedAt: Date.now() },
        },
        errors: [],
      };
    }
  }

  // ── Fetch missing/stale sections in parallel ────────────────────────────

  const fetchPromises: Promise<void>[] = [];

  if (needFetchChanges) {
    const isBackground = cachedChanges?.status === "stale";
    const p = (async () => {
      try {
        const result = await fetchChanges(serviceName, providers);
        if (result !== null) {
          changesData = result;
          setCache(serviceName, "changes", result);
          sections.changes = { status: "ok", fetchedAt: Date.now() };
        } else if (!cachedChanges) {
          sections.changes = { status: "unconfigured" };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isBackground) {
          errors.push(`changes: ${msg}`);
          if (!cachedChanges) {
            sections.changes = { status: "error", error: msg };
          }
        }
        logger.debug({ err, service: serviceName }, "service-brief: changes fetch failed");
      }
    })();
    if (!isBackground) fetchPromises.push(p);
  }

  if (needFetchInfra) {
    const isBackground = cachedInfra?.status === "stale";
    const p = (async () => {
      try {
        const result = await fetchInfrastructure(serviceName, providers);
        if (result !== null) {
          infraData = result;
          setCache(serviceName, "infrastructure", result);
          sections.infrastructure = { status: "ok", fetchedAt: Date.now() };
        } else if (!cachedInfra) {
          sections.infrastructure = { status: "unconfigured" };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isBackground) {
          errors.push(`infrastructure: ${msg}`);
          if (!cachedInfra) {
            sections.infrastructure = { status: "error", error: msg };
          }
        }
        logger.debug({ err, service: serviceName }, "service-brief: infrastructure fetch failed");
      }
    })();
    if (!isBackground) fetchPromises.push(p);
  }

  if (needFetchDeps) {
    const isBackground = cachedDeps?.status === "stale";
    const p = (async () => {
      try {
        const result = await fetchDependencies(serviceName, services, healthPoller);
        depsData = result;
        setCache(serviceName, "dependencies", result);
        sections.dependencies = { status: "ok", fetchedAt: Date.now() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isBackground) {
          errors.push(`dependencies: ${msg}`);
          if (!cachedDeps) {
            sections.dependencies = { status: "error", error: msg };
          }
        }
        logger.debug({ err, service: serviceName }, "service-brief: dependencies fetch failed");
      }
    })();
    if (!isBackground) fetchPromises.push(p);
  }

  // Wait for all non-background fetches
  await Promise.allSettled(fetchPromises);

  // ── AI Summary ──────────────────────────────────────────────────────────

  let summaryData: AISummary | null = null;

  if (llmModel) {
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

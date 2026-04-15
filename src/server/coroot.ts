/**
 * Coroot neighbor fetcher for the investigation workflow.
 *
 * Contract: given a service name, return a list of 1-hop neighbors from
 * Coroot's eBPF-based service map, together with per-neighbor direction
 * (upstream caller / downstream callee), status (healthy/degraded/unhealthy),
 * and optionally a request rate from the SLO report. Designed to be called
 * once per investigation prefetch; the evidence for the top-N ranked
 * unhealthy neighbors is fetched separately by `neighbor-evidence.ts`.
 *
 * Duplication note: a few small MCP utilities (withTimeout, findTool,
 * parseMcpResult) are copied from `service-brief.ts` rather than extracted
 * into a shared module. This is a deliberate trade-off to avoid touching
 * `service-brief.ts` (which has a large regression surface). See the
 * Coroot investigation design doc F-Eng-1 / F-Eng-15 for rationale.
 */

import { createLogger } from "../logger.js";
import { getToolsByRole, type MastraProvider } from "../mcp/provider.js";
import type { ServiceConfig } from "../config/schema.js";
import type { Neighbor } from "../types/workflow-state.js";

const logger = createLogger();

const SECTION_TIMEOUT_MS = 10_000;

// ── Local MCP utilities (duplicated from service-brief.ts, see note above) ───

type ExecutableTool = { execute: (args: Record<string, unknown>) => Promise<unknown> };

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function findTool(
  tools: Record<string, unknown>,
  keywords: string[],
): ExecutableTool | null {
  for (const [name, tool] of Object.entries(tools)) {
    const lower = name.toLowerCase();
    const desc = ((tool as { description?: string }).description ?? "").toLowerCase();
    if (keywords.some((kw) => lower.includes(kw) || desc.includes(kw))) {
      return tool as ExecutableTool;
    }
  }
  return null;
}

function parseMcpResult(raw: unknown): unknown {
  if (!raw) return null;
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
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

// ── Pure parsing helpers ─────────────────────────────────────────────────────

/** Extract the short service name from a Coroot app ID.
 * Example: "default:Deployment:ingestion-server" → "ingestion-server". */
export function extractServiceName(corootId: string): string {
  const parts = corootId.split(":");
  return parts[parts.length - 1];
}

/** Map Coroot app status string to a Neighbor status. */
export function mapCorootStatus(corootStatus: string | undefined): Neighbor["status"] {
  if (corootStatus === "ok") return "healthy";
  if (corootStatus === "warning") return "degraded";
  if (corootStatus === "critical") return "unhealthy";
  return "unknown";
}

/** Extract per-client request rate from the SLO report table if available.
 * Returns a Map keyed by the short service name (the `cells[0].value`). */
export function extractSloRates(
  reports: unknown[],
): Map<string, { reqs?: string; latency?: string }> {
  const rates = new Map<string, { reqs?: string; latency?: string }>();
  if (!Array.isArray(reports)) return rates;
  const sloReport = reports.find(
    (r: unknown) => r != null && typeof r === "object" && (r as { name?: string }).name === "SLO",
  );
  if (!sloReport) return rates;
  const widgets = (sloReport as { widgets?: unknown[] }).widgets;
  if (!Array.isArray(widgets)) return rates;
  for (const w of widgets) {
    const table = (w as { table?: { rows?: unknown[] } }).table;
    if (!table?.rows) continue;
    for (const row of table.rows) {
      const cells = (row as { cells?: unknown[] }).cells;
      if (!Array.isArray(cells) || cells.length < 4) continue;
      const clientCell = cells[0] as { value?: string };
      const reqCell = cells[2] as { value?: string };
      const latCell = cells[3] as { value?: string };
      const clientName = clientCell.value ?? "";
      if (clientName) {
        rates.set(clientName, { reqs: reqCell.value, latency: latCell.value });
      }
    }
  }
  return rates;
}

// ── Server-lifetime registry cache ───────────────────────────────────────────

let cachedCorootProjectId: string | undefined;
let cachedCorootAppRegistry: { id: string; status: string }[] | undefined;
let corootRegistryPromise: Promise<void> | undefined;

/** Visible for tests: reset the server-lifetime registry cache between runs. */
export function resetCorootRegistryCache(): void {
  cachedCorootProjectId = undefined;
  cachedCorootAppRegistry = undefined;
  corootRegistryPromise = undefined;
}

/** Resolve Coroot project ID and app registry, cache on success.
 * On transient failure, leaves cache undefined so the next call retries. */
async function ensureCorootRegistry(
  tools: Record<string, unknown>,
): Promise<{ projectId: string; appRegistry: { id: string; status: string }[] } | null> {
  if (cachedCorootProjectId !== undefined && cachedCorootProjectId !== "") {
    return {
      projectId: cachedCorootProjectId,
      appRegistry: cachedCorootAppRegistry ?? [],
    };
  }

  if (corootRegistryPromise) {
    await corootRegistryPromise;
    if (cachedCorootProjectId !== undefined && cachedCorootProjectId !== "") {
      return {
        projectId: cachedCorootProjectId,
        appRegistry: cachedCorootAppRegistry ?? [],
      };
    }
    return null;
  }

  corootRegistryPromise = (async () => {
    const projectsTool = findTool(tools, ["list_projects"]);
    if (!projectsTool) {
      cachedCorootProjectId = ""; // sentinel: permanent miss, no tool available
      return;
    }
    try {
      const projRaw = await withTimeout(
        projectsTool.execute({}),
        SECTION_TIMEOUT_MS,
        "coroot:list_projects",
      );
      const projParsed = parseMcpResult(projRaw) as
        | { projects?: { id: string; name: string }[] }
        | null;
      const id = projParsed?.projects?.[0]?.id;
      if (!id) {
        logger.warn("coroot: list_projects returned no projects, will retry next request");
        return;
      }
      cachedCorootProjectId = id;
    } catch (err) {
      logger.warn({ err }, "coroot: list_projects failed, will retry next request");
      return;
    }

    const overviewTool = findTool(tools, ["applications_overview", "overview"]);
    if (!overviewTool) return;
    try {
      const overviewRaw = await withTimeout(
        overviewTool.execute({ project_id: cachedCorootProjectId }),
        SECTION_TIMEOUT_MS,
        "coroot:applications_overview",
      );
      const overviewParsed = parseMcpResult(overviewRaw) as
        | { overview?: { context?: { search?: { applications?: { id: string; status: string }[] } } } }
        | null;
      cachedCorootAppRegistry =
        overviewParsed?.overview?.context?.search?.applications ?? [];
      logger.info(
        { projectId: cachedCorootProjectId, appCount: cachedCorootAppRegistry.length },
        "coroot: cached app registry",
      );
    } catch (err) {
      logger.debug({ err }, "coroot: app registry fetch failed");
    }
  })();

  await corootRegistryPromise;
  corootRegistryPromise = undefined;

  if (cachedCorootProjectId !== undefined && cachedCorootProjectId !== "") {
    return {
      projectId: cachedCorootProjectId,
      appRegistry: cachedCorootAppRegistry ?? [],
    };
  }
  return null;
}

// ── Neighbor fetcher entry point ─────────────────────────────────────────────

/**
 * Fetch 1-hop Coroot neighbors for the given service.
 *
 * Returns `null` when:
 * - no `dependencies`-role provider is configured
 * - the `get_application` tool is not available
 * - the Coroot registry lookup fails (transient, caller treats as no data)
 * - the service's Coroot app ID cannot be resolved (direct match + services[*].corootAppId)
 *
 * Returns `[]` when the call succeeds but Coroot has no 1-hop neighbors for this service.
 *
 * Identity resolution: matches the existing Phase 1 behavior in service-brief.ts
 * (direct name match on `extractServiceName(app.id)` against `services[*].name`,
 * with optional `services[*].corootAppId` override). **Does not** attempt fuzzy
 * suffix stripping — per Codex C6, the policy is locked to direct-match + alias only.
 */
export async function fetchCorootNeighbors(
  serviceName: string,
  providers: MastraProvider[],
  services: ServiceConfig[],
): Promise<Neighbor[] | null> {
  const tools = (await getToolsByRole(providers, "dependencies")) as Record<string, unknown>;
  if (Object.keys(tools).length === 0) return null;

  // Exact keyword — "application" alone would also match applications_overview.
  const appTool = findTool(tools, ["get_application"]);
  if (!appTool) return null;

  const registry = await ensureCorootRegistry(tools);
  if (!registry) return null;
  const { projectId, appRegistry } = registry;

  // Resolve Coroot app ID for the primary service
  const svcConfig = services.find((s) => s.name === serviceName);
  let appId = svcConfig?.corootAppId;
  if (!appId && appRegistry.length > 0) {
    const match = appRegistry.find((a) => extractServiceName(a.id) === serviceName);
    if (match) appId = match.id;
  }
  if (!appId) return null;

  // Call get_application
  let raw: unknown;
  try {
    raw = await withTimeout(
      appTool.execute({ project_id: projectId, app_id: appId }),
      SECTION_TIMEOUT_MS,
      "coroot:get_application",
    );
  } catch (err) {
    logger.warn({ err, service: serviceName }, "coroot: get_application failed");
    return null;
  }

  const parsed = parseMcpResult(raw) as {
    success?: boolean;
    application?: { data?: { app_map?: unknown; reports?: unknown[] } };
  } | null;
  if (!parsed?.success || !parsed?.application?.data) return null;

  const appMap = parsed.application.data.app_map as {
    application: { icon?: string; status?: string };
    clients?: { id: string; icon?: string; status?: string; link_status?: string; link_direction?: string }[];
    dependencies?: { id: string; icon?: string; status?: string; link_status?: string; link_direction?: string }[];
  } | null;
  if (!appMap) return [];

  const sloRates = extractSloRates(parsed.application.data.reports ?? []);

  // Build neighbors map — dedupe by short name, accumulate directions,
  // worst-wins on status, first-non-null on rate.
  const byName = new Map<string, Neighbor>();
  const severity = (s: Neighbor["status"]): number =>
    ({ unhealthy: 3, degraded: 2, unknown: 1, healthy: 0 })[s];

  const upsert = (
    corootId: string,
    corootStatus: string | undefined,
    direction: "upstream" | "downstream",
  ): void => {
    if (!corootId) return;
    const name = extractServiceName(corootId);
    if (name === serviceName) return; // don't include self in neighbor list
    const status = mapCorootStatus(corootStatus);
    const inServiceRegistry = services.some(
      (s) => s.name === name || s.corootAppId === corootId,
    );
    const rateEntry = sloRates.get(name);
    const requestRate = rateEntry?.reqs;

    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, {
        name,
        directions: [direction],
        status,
        inServiceRegistry,
        ...(requestRate !== undefined ? { requestRate } : {}),
      });
      return;
    }
    // Merge directions
    if (!existing.directions.includes(direction)) {
      existing.directions = [...existing.directions, direction].sort() as Neighbor["directions"];
    }
    // Worst-wins on status
    if (severity(status) > severity(existing.status)) {
      existing.status = status;
    }
    // First-non-null on rate (existing wins if set)
    if (existing.requestRate === undefined && requestRate !== undefined) {
      existing.requestRate = requestRate;
    }
  };

  // Clients: services that CALL this service (upstream callers).
  for (const client of appMap.clients ?? []) {
    upsert(client.id, client.status, "upstream");
  }
  // Dependencies: services this service CALLS (downstream callees).
  for (const dep of appMap.dependencies ?? []) {
    upsert(dep.id, dep.status, "downstream");
  }

  return Array.from(byName.values());
}

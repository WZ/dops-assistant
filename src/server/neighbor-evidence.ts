/**
 * Fetches deterministic metric and log evidence for a Coroot neighbor.
 *
 * Option 3 (see design doc): the prefetch step calls `fetchCorootNeighbors()`
 * to discover 1-hop neighbors, ranks the unhealthy/degraded/unknown ones,
 * filters to registry-backed names, and then calls this module to pull
 * actual PromQL + LogQL evidence via the existing metrics/logs-role MCP tools.
 * The result is a `NeighborEvidence` structure that synthesis cites in its
 * prompt and deterministically injects into `evidence.metrics`/`evidence.logs`.
 *
 * The plan rejected the alternative of routing neighbor queries through the
 * metrics/logs evidence agents because their system prompts (src/agents/metrics.ts
 * :21 and src/agents/logs.ts:21) explicitly refuse to query non-primary services.
 */

import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import { getToolsByRole } from "../mcp/provider.js";
import type { ServiceConfig } from "../config/schema.js";
import type {
  Neighbor,
  NeighborEvidence,
  NeighborMetricSample,
  NeighborLogSample,
} from "../types/workflow-state.js";
import { queryServiceMetrics } from "./prometheus-query.js";

const logger = createLogger();

// ── Selection: rank & cap which neighbors get evidence fetched ───────────────

export interface SelectNeighborsOptions {
  /** Maximum number of neighbors to fetch evidence for. Default 3. Hard cap. */
  maxNeighbors?: number;
  /** Minimum severity to include. "degraded" means {degraded, unhealthy, unknown}. Default "degraded". */
  minStatus?: "degraded" | "unhealthy";
  /** Only include neighbors whose name matches a services.yaml entry. Default true. */
  requireInRegistry?: boolean;
}

const SEVERITY_ORDER: Record<Neighbor["status"], number> = {
  unhealthy: 3,
  degraded: 2,
  unknown: 1,
  healthy: 0,
};

/**
 * Pick the top-N neighbors worth fetching evidence for.
 *
 * Ranking: severity (unhealthy > degraded > unknown) first, then requestRate
 * descending as a tiebreaker (higher-traffic neighbors are more likely to
 * affect the primary).
 *
 * Filtering: drops healthy neighbors by default, drops neighbors not in the
 * service registry (we need metric/log query templates to get meaningful data).
 */
export function selectNeighborsForEvidenceFetch(
  neighbors: Neighbor[],
  options?: SelectNeighborsOptions,
): Neighbor[] {
  const maxNeighbors = options?.maxNeighbors ?? 3;
  const requireInRegistry = options?.requireInRegistry ?? true;

  // "degraded" means degraded + unhealthy + unknown; "unhealthy" means unhealthy only
  const minStatus = options?.minStatus ?? "degraded";
  const statusAllowed = (s: Neighbor["status"]): boolean => {
    if (minStatus === "unhealthy") return s === "unhealthy";
    return s === "unhealthy" || s === "degraded" || s === "unknown";
  };

  const filtered = neighbors
    .filter((n) => statusAllowed(n.status))
    .filter((n) => !requireInRegistry || n.inServiceRegistry);

  // Parse requestRate string (e.g. "42" or "12.5") to number; missing → 0.
  const rateOf = (n: Neighbor): number => {
    if (!n.requestRate) return 0;
    const parsed = parseFloat(n.requestRate);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  filtered.sort((a, b) => {
    const sev = SEVERITY_ORDER[b.status] - SEVERITY_ORDER[a.status];
    if (sev !== 0) return sev;
    return rateOf(b) - rateOf(a);
  });

  return filtered.slice(0, maxNeighbors);
}

// ── Evidence fetch: PromQL + LogQL via MCP tools ─────────────────────────────

/** Find a Loki log query tool from the logs-role tools. */
function findLogQueryTool(tools: Record<string, unknown>): { execute: (args: unknown) => Promise<unknown> } | null {
  for (const [name, tool] of Object.entries(tools)) {
    const lower = name.toLowerCase();
    if (lower.includes("query_loki") || lower.includes("query_logs") || lower.endsWith("query")) {
      return tool as { execute: (args: unknown) => Promise<unknown> };
    }
  }
  // Fallback: any tool with "log" in the name that isn't a listing tool
  for (const [name, tool] of Object.entries(tools)) {
    const lower = name.toLowerCase();
    if (lower.includes("log") && !lower.includes("label") && !lower.includes("list")) {
      return tool as { execute: (args: unknown) => Promise<unknown> };
    }
  }
  return null;
}

/** Parse an MCP result envelope into its inner text/json payload. */
function parseMcpPayload(raw: unknown): unknown {
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

/** Extract a flat list of log line strings from a Loki MCP result. */
function extractLogLines(payload: unknown, limit: number): { lines: string[]; count: number } {
  if (!payload || typeof payload !== "object") return { lines: [], count: 0 };
  const obj = payload as Record<string, unknown>;

  // Try common shapes: { streams: [{values: [[ts, line]]}] }, { data: {result: [{values}]}}
  const streams =
    (obj.streams as unknown[]) ??
    ((obj.data as Record<string, unknown>)?.result as unknown[]) ??
    (obj.result as unknown[]) ??
    null;

  if (!Array.isArray(streams)) return { lines: [], count: 0 };

  const lines: string[] = [];
  let total = 0;
  for (const stream of streams) {
    const values = (stream as { values?: unknown[] }).values;
    if (!Array.isArray(values)) continue;
    for (const v of values) {
      total++;
      if (lines.length >= limit) continue;
      // values shape: [timestamp, line] tuple
      if (Array.isArray(v) && v.length >= 2 && typeof v[1] === "string") {
        lines.push(String(v[1]).slice(0, 500));
      }
    }
  }
  return { lines, count: total };
}

const PER_QUERY_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * Fetch metric + log evidence for one neighbor.
 *
 * Metrics: reuses `queryServiceMetrics` from prometheus-query.ts. When the
 * neighbor has a ServiceConfig with `metrics[]` templates, those templates
 * are used. Otherwise the HTTP-shaped defaults run and typically return empty
 * for non-HTTP workloads (Kafka, Redis, databases, etc.) — this is the
 * F-Eng-9 constraint: for meaningful evidence, the neighbor must be
 * pre-registered in services.yaml with matching PromQL templates.
 *
 * Logs: a single LogQL query `{service="X"} |~ "(?i)(error|exception|fail)"`
 * bounded to 10 lines and a 3-second timeout.
 *
 * Soft errors are captured in `fetchErrors[]`; the function never throws.
 */
export async function fetchNeighborEvidence(
  neighbor: Neighbor,
  providers: MastraProvider[],
  services: ServiceConfig[],
): Promise<NeighborEvidence> {
  const fetchErrors: string[] = [];
  const metrics: NeighborMetricSample[] = [];
  const logs: NeighborLogSample[] = [];
  const fetchedAt = new Date().toISOString();

  const serviceConfig = services.find((s) => s.name === neighbor.name);

  // ── Metrics ────────────────────────────────────────────────────────────────
  try {
    const results = await withTimeout(
      queryServiceMetrics(neighbor.name, "1h", providers, serviceConfig?.metrics),
      PER_QUERY_TIMEOUT_MS * 4,
      `neighbor-evidence:metrics:${neighbor.name}`,
    );
    for (const series of results) {
      metrics.push({
        query: series.query,
        values: series.values
          .slice(-5)
          .map(([t, v]) => [t, String(v)] as [string, string]),
      });
    }
    if (metrics.every((m) => m.values.length === 0)) {
      fetchErrors.push("metrics: all queries returned empty results");
    }
  } catch (err) {
    const msg = `metrics: ${(err as Error).message}`;
    fetchErrors.push(msg);
    logger.warn({ err, neighbor: neighbor.name }, "neighbor-evidence: metrics fetch failed");
  }

  // ── Logs ───────────────────────────────────────────────────────────────────
  try {
    const logTools = (await getToolsByRole(providers, "logs")) as Record<string, unknown>;
    if (Object.keys(logTools).length === 0) {
      fetchErrors.push("logs: no logs-role provider configured");
    } else {
      const logTool = findLogQueryTool(logTools);
      if (!logTool) {
        fetchErrors.push("logs: no query tool in logs-role provider");
      } else {
        // Minimal LogQL: select by service label, grep for error-ish patterns, limit 10.
        // Labels may not match; empty result is not an error (just no logs for this
        // service in the time window).
        //
        // F4 fix: escape neighbor names and label values to prevent LogQL injection.
        // LogQL uses double-quoted strings with Go's strconv.Quote rules — escape
        // backslash and double quote. We also strictly reject any name/value that
        // contains control characters or line breaks.
        const isSafeLogqlValue = (v: string): boolean =>
          !/[\u0000-\u001f\u007f]/.test(v);
        const escapeLogqlValue = (v: string): string =>
          v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        // Also validate label keys — LogQL label names are restricted to
        // [a-zA-Z_][a-zA-Z0-9_]* and will be quietly dropped otherwise.
        const isSafeLabelKey = (k: string): boolean => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k);

        let selector: string;
        if (serviceConfig?.logLabels) {
          const parts: string[] = [];
          for (const [k, v] of Object.entries(serviceConfig.logLabels as Record<string, string>)) {
            if (!isSafeLabelKey(k) || typeof v !== "string" || !isSafeLogqlValue(v)) {
              fetchErrors.push(`logs: dropped unsafe label ${k}`);
              continue;
            }
            parts.push(`${k}="${escapeLogqlValue(v)}"`);
          }
          selector = parts.join(",");
        } else {
          if (!isSafeLogqlValue(neighbor.name)) {
            fetchErrors.push(`logs: neighbor name contains unsafe characters`);
            logs.push({ query: "", lines: [], count: 0, error: "unsafe neighbor name" });
            throw new Error("unsafe neighbor name, skipping logs fetch");
          }
          selector = `service="${escapeLogqlValue(neighbor.name)}"`;
        }
        // If every label was rejected, bail out rather than issue a `{}` query
        // (which would match all logs).
        if (selector === "") {
          logs.push({ query: "", lines: [], count: 0, error: "no safe labels" });
          throw new Error("no safe log labels, skipping logs fetch");
        }
        const logql = `{${selector}} |~ "(?i)(error|exception|fail)"`;
        const raw = await withTimeout(
          logTool.execute({
            query: logql,
            limit: 10,
            startRfc3339: new Date(Date.now() - 60 * 60_000).toISOString(),
            endRfc3339: new Date().toISOString(),
          }),
          PER_QUERY_TIMEOUT_MS,
          `neighbor-evidence:logs:${neighbor.name}`,
        );
        const payload = parseMcpPayload(raw);
        const { lines, count } = extractLogLines(payload, 10);
        logs.push({ query: logql, lines, count });
      }
    }
  } catch (err) {
    const msg = `logs: ${(err as Error).message}`;
    fetchErrors.push(msg);
    logger.warn({ err, neighbor: neighbor.name }, "neighbor-evidence: logs fetch failed");
  }

  return { metrics, logs, fetchedAt, fetchErrors };
}

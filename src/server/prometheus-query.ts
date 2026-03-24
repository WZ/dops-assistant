/**
 * Shared Prometheus query module — queries service metrics via MCP tools.
 *
 * Reuses the same MCP tool calling pattern as service-health-poller.ts:
 *   1. Find providers with "metrics" role
 *   2. Get query_prometheus + list_datasources tools
 *   3. Execute PromQL queries and parse Prometheus response format
 *
 * The parsePrometheusResult function from service-health-poller is reused
 * directly to avoid duplicating response parsing logic.
 */

import pino from "pino";
import type { MastraProvider } from "../mcp/provider.js";
import { getToolsByRole } from "../mcp/provider.js";
import { parsePrometheusResult } from "./service-health-poller.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export interface MetricSeries {
  name: string;
  query: string;
  unit: string;
  current: number;
  values: [string, number][]; // [unix_timestamp_string, value] — matches TimeSeriesData
  min?: number;
  max?: number;
  avg?: number;
  fetchedAt: number; // unix timestamp for cache freshness
}

/** Map range strings to seconds for Prometheus query window. */
const RANGE_SECONDS: Record<string, number> = {
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
};

/** Sanitize a service name for safe embedding in PromQL label selectors. */
function sanitizeForPromQL(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.\-]/g, "");
}

/** Default PromQL queries when a service has no configured metrics. */
function buildDefaultQueries(serviceName: string): { name: string; query: string; unit: string }[] {
  const safe = sanitizeForPromQL(serviceName);
  return [
    {
      name: "Request Rate",
      query: `sum(rate(http_requests_total{service=~".*${safe}.*"}[5m]))`,
      unit: "req/s",
    },
    {
      name: "Error Rate",
      query: `sum(rate(http_requests_total{service=~".*${safe}.*",code=~"5.."}[5m])) / sum(rate(http_requests_total{service=~".*${safe}.*"}[5m])) * 100`,
      unit: "%",
    },
    {
      name: "Latency P99",
      query: `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{service=~".*${safe}.*"}[5m])) by (le)) * 1000`,
      unit: "ms",
    },
    {
      name: "Pod Replicas",
      query: `kube_deployment_status_replicas{deployment=~".*${safe}.*"}`,
      unit: "",
    },
  ];
}

/** Infer a display name from a PromQL expression. */
function inferMetricName(query: string): string {
  // Try to extract the metric name from the expression
  const match = query.match(/^[a-z_:]+/i) ?? query.match(/\b([a-z_]+)\{/i);
  if (match) {
    return match[1] ?? match[0];
  }
  return query.slice(0, 40);
}

/** Infer unit from metric name heuristics. */
function inferUnit(query: string): string {
  const q = query.toLowerCase();
  if (q.includes("rate(") && q.includes("* 100")) return "%";
  if (q.includes("rate(")) return "req/s";
  if (q.includes("bytes")) return "bytes";
  if (q.includes("duration") || q.includes("latency")) return "s";
  if (q.includes("replica")) return "";
  return "";
}

type ToolExecutor = { execute: (args: unknown) => Promise<unknown> };

/**
 * Find the query_prometheus tool from a tools record.
 * Mirrors the pattern in ServiceHealthPoller.findQueryPrometheusTool.
 */
function findQueryPrometheusTool(tools: Record<string, unknown>): ToolExecutor | null {
  for (const [name, tool] of Object.entries(tools)) {
    if (name === "query_prometheus" || name.endsWith("_query_prometheus")) {
      return tool as ToolExecutor;
    }
  }
  return null;
}

/**
 * Find the Prometheus datasource UID via MCP list_datasources tool.
 * Mirrors the pattern in ServiceHealthPoller.findPrometheusDatasourceUid.
 */
async function findPrometheusDatasourceUid(
  tools: Record<string, unknown>,
): Promise<string | undefined> {
  const listDsTool = Object.entries(tools).find(([name]) => name.endsWith("list_datasources"));
  if (!listDsTool) return undefined;
  try {
    const result = await (listDsTool[1] as ToolExecutor).execute({});
    const outer = typeof result === "string" ? JSON.parse(result) : result;
    const data = outer?.content?.[0]?.text ? JSON.parse(outer.content[0].text) : outer;
    const datasources = Array.isArray(data) ? data : (data as Record<string, unknown>)?.datasources ?? [];
    const prom = (datasources as Record<string, unknown>[]).find(
      (ds) =>
        ds.type === "prometheus" ||
        (ds.typeName as string)?.toLowerCase().includes("prometheus") ||
        (ds.name as string)?.toLowerCase().includes("prometheus"),
    );
    if (prom?.uid) {
      return prom.uid as string;
    }
  } catch (err) {
    logger.warn({ err }, "prometheus-query: failed to find Prometheus datasource UID");
  }
  return undefined;
}

/**
 * Execute a single Prometheus query via MCP and return parsed values.
 * Attempts range_query first (for time series), falls back to instant query.
 */
async function executeQuery(
  tool: ToolExecutor,
  query: string,
  rangeSeconds: number,
  datasourceUid?: string,
): Promise<{ values: [string, number][]; current: number }> {
  const now = new Date();
  const startTime = new Date(now.getTime() - rangeSeconds * 1000).toISOString();
  const endTime = now.toISOString();

  // Compute a reasonable step based on range to get ~120 data points
  const stepSeconds = Math.max(15, Math.floor(rangeSeconds / 120));

  // Try range query first for time series data
  const args: Record<string, unknown> = {
    expr: query,
    queryType: "range",
    startTime,
    endTime,
    step: `${stepSeconds}s`,
  };
  if (datasourceUid) args.datasourceUid = datasourceUid;

  try {
    const result = await tool.execute(args);
    const entries = parsePrometheusResult(result);

    if (entries.length > 0) {
      // Range query returns entries with `values` array: [[timestamp, "value"], ...]
      const firstEntry = entries[0]!;
      if (firstEntry.values && firstEntry.values.length > 0) {
        const values: [string, number][] = firstEntry.values.map(([ts, val]) => [
          String(ts),
          parseFloat(val),
        ]);
        const current = values.length > 0 ? values[values.length - 1]![1] : 0;
        return { values, current };
      }

      // Instant-style result within range query response
      if (firstEntry.value) {
        const val = parseFloat(firstEntry.value[1]);
        const ts = String(firstEntry.value[0]);
        return { values: [[ts, val]], current: isNaN(val) ? 0 : val };
      }
    }
  } catch (err) {
    logger.debug({ err, query }, "prometheus-query: range query failed, trying instant");
  }

  // Fallback: instant query
  const instantArgs: Record<string, unknown> = {
    expr: query,
    queryType: "instant",
    startTime,
    endTime,
  };
  if (datasourceUid) instantArgs.datasourceUid = datasourceUid;

  try {
    const result = await tool.execute(instantArgs);
    const entries = parsePrometheusResult(result);

    if (entries.length > 0 && entries[0]!.value) {
      const val = parseFloat(entries[0]!.value![1]);
      const ts = String(entries[0]!.value![0]);
      return { values: [[ts, isNaN(val) ? 0 : val]], current: isNaN(val) ? 0 : val };
    }
  } catch (err) {
    logger.warn({ err, query }, "prometheus-query: instant query also failed");
  }

  return { values: [], current: 0 };
}

/**
 * Query Prometheus for service metrics via MCP tools.
 *
 * @param serviceName - Service to query metrics for
 * @param range - Time range: "1h" | "6h" | "24h" | "7d"
 * @param providers - MCP providers (filters to "metrics" role)
 * @param registryMetrics - Optional per-service metric configs from services.yaml
 */
export async function queryServiceMetrics(
  serviceName: string,
  range: string,
  providers: MastraProvider[],
  registryMetrics?: { query: string; description: string }[],
): Promise<MetricSeries[]> {
  const rangeSeconds = RANGE_SECONDS[range] ?? RANGE_SECONDS["24h"]!;

  // Get tools from providers with "metrics" role
  let tools: Record<string, unknown>;
  try {
    tools = (await getToolsByRole(providers, "metrics")) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, "prometheus-query: failed to get MCP tools for metrics role");
    return [];
  }

  const queryTool = findQueryPrometheusTool(tools);
  if (!queryTool) {
    logger.warn("prometheus-query: query_prometheus tool not found");
    return [];
  }

  // Find the Prometheus datasource UID
  const datasourceUid = await findPrometheusDatasourceUid(tools);

  // Build query list: always include defaults, then add registry-specific metrics
  const defaults = buildDefaultQueries(serviceName);
  const defaultQuerySet = new Set(defaults.map((d) => d.query));

  const registryExtras = (registryMetrics ?? [])
    .filter((m) => !defaultQuerySet.has(m.query))
    .map((m) => ({
      name: m.description || inferMetricName(m.query),
      query: m.query,
      unit: inferUnit(m.query),
    }));

  const queries = [...defaults, ...registryExtras];

  // Execute all queries in parallel
  const fetchedAt = Date.now();
  const results = await Promise.all(
    queries.map(async (q) => {
      try {
        const { values, current } = await executeQuery(queryTool, q.query, rangeSeconds, datasourceUid);

        // Compute min/avg/max from values
        let min: number | undefined;
        let max: number | undefined;
        let avg: number | undefined;

        if (values.length > 0) {
          const nums = values.map(([, v]) => v).filter((v) => !isNaN(v));
          if (nums.length > 0) {
            min = Math.min(...nums);
            max = Math.max(...nums);
            avg = nums.reduce((a, b) => a + b, 0) / nums.length;
          }
        }

        return {
          name: q.name,
          query: q.query,
          unit: q.unit,
          current,
          values,
          min,
          max,
          avg,
          fetchedAt,
        } satisfies MetricSeries;
      } catch (err) {
        logger.warn({ err, query: q.query }, "prometheus-query: query execution failed");
        return {
          name: q.name,
          query: q.query,
          unit: q.unit,
          current: 0,
          values: [],
          fetchedAt,
        } satisfies MetricSeries;
      }
    }),
  );

  return results;
}

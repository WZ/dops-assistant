/**
 * instant-query — shared helpers for executing single PromQL/LogQL instant
 * queries via an MCP tool. Extracted from anomaly-probe.ts so other
 * components (e.g. the periodic discovery sanity probe) can reuse the same
 * "fire one query, parse a scalar, never throw" primitive.
 *
 * Behavior is byte-stable with the original definitions in anomaly-probe.ts:
 *   - 5-minute window for metric instant queries.
 *   - 15-minute window for Loki count_over_time queries (queryType: "metric").
 *   - Caller-provided AbortSignal chained into a per-query timeout controller.
 *   - Never throws — returns a discriminated `InstantResult` so callers can
 *     distinguish real MCP failures from empty result vectors (which are the
 *     normal, expected case whenever a rule's labels don't match active series).
 */

import { createLogger } from "../logger.js";
import { parsePrometheusResult } from "./service-health-poller.js";

const logger = createLogger();

/**
 * Per-query outcome. `ok` carries a numeric scalar; `empty` means the query
 * succeeded but returned no rows; `error` means the MCP tool threw, timed
 * out, or returned a parse-failing payload. Value is always NaN for `empty`
 * and `error` so scoring code that treats NaN as no-trip keeps working.
 */
export type InstantOutcome = "ok" | "empty" | "error";
export interface InstantResult {
  kind: InstantOutcome;
  value: number;
}

interface ToolExecutor {
  execute: (args: unknown, context?: { abortSignal?: AbortSignal }) => Promise<unknown>;
}

/**
 * Wrap an MCP tool invocation with a timeout-bounded AbortController that is
 * also chained into the caller's signal. Never throws — returns `undefined`
 * on any failure (network error, timeout, aborted signal, MCP server
 * ignoring the abort). Each track's executor parses the returned raw value
 * into its own scalar.
 */
export async function withTimeoutAndAbort(
  tool: ToolExecutor,
  args: unknown,
  signal: AbortSignal | undefined,
  queryTimeoutMs: number,
): Promise<unknown | undefined> {
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), queryTimeoutMs);
  // Chain the caller's signal into the timeout controller so an external
  // abort tears this down too. Belt-and-suspenders: if the MCP server
  // ignores abortSignal, the timeoutHandle still fires.
  const onExternalAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    return await tool.execute(args, { abortSignal: timeoutController.signal });
  } catch (err) {
    logger.warn({ err }, "instant-query: tool invocation failed, scoring as no-trip");
    return undefined;
  } finally {
    clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}

/** Extract the first numeric scalar from a Prometheus-shaped result. NaN on miss. */
function scalarFromPromResult(raw: unknown): number {
  const entries = parsePrometheusResult(raw);
  if (entries.length === 0) return Number.NaN;
  const first = entries[0];
  if (!first) return Number.NaN;
  // Instant query shape: { value: [timestamp, "stringValue"] }
  if (first.value && Array.isArray(first.value) && first.value.length >= 2) {
    const parsed = parseFloat(String(first.value[1]));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  // Range query shape: { values: [[ts, "v"], ...] } — take the latest sample.
  if (first.values && Array.isArray(first.values) && first.values.length > 0) {
    const latest = first.values[first.values.length - 1];
    if (latest && latest.length >= 2) {
      const parsed = parseFloat(String(latest[1]));
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    }
  }
  return Number.NaN;
}

/**
 * Execute one instant PromQL query via the metrics MCP tool. Never throws.
 * Returns a discriminated outcome so the caller can distinguish real MCP
 * failures from empty vectors (which are normal and expected whenever a
 * rule's labels don't match any active series).
 */
export async function executeInstantMetric(
  tool: ToolExecutor,
  query: string,
  datasourceUid: string | undefined,
  signal: AbortSignal | undefined,
  queryTimeoutMs: number,
): Promise<InstantResult> {
  const now = new Date();
  const args: Record<string, unknown> = {
    expr: query,
    queryType: "instant",
    startTime: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    endTime: now.toISOString(),
  };
  if (datasourceUid) args.datasourceUid = datasourceUid;
  const raw = await withTimeoutAndAbort(tool, args, signal, queryTimeoutMs);
  if (raw === undefined) return { kind: "error", value: Number.NaN };
  const value = scalarFromPromResult(raw);
  return Number.isFinite(value)
    ? { kind: "ok", value }
    : { kind: "empty", value: Number.NaN };
}

/**
 * Log-source executor: scalar count from a LogQL `count_over_time(...)`
 * query. Uses Grafana MCP `query_loki_logs` with `queryType: "metric"`,
 * which returns a metric vector (same shape Prometheus instant queries
 * return) rather than log lines. Never throws — NaN on failure, timeout,
 * or when the logs tool isn't wired.
 *
 * If the tool rejects `queryType: "metric"` (older Grafana MCP versions),
 * withTimeoutAndAbort catches the error and every log-source rule in the
 * tick silently scores NaN. The scan-scheduler tick log surfaces the
 * warning so operators notice and upgrade.
 */
export async function executeInstantLogs(
  tool: ToolExecutor,
  query: string,
  lokiDatasourceUid: string | undefined,
  signal: AbortSignal | undefined,
  queryTimeoutMs: number,
): Promise<InstantResult> {
  // No Loki datasource wired is a config gap, not a query error. Treat as empty.
  if (!lokiDatasourceUid) return { kind: "empty", value: Number.NaN };
  const now = new Date();
  const args: Record<string, unknown> = {
    expr: query,
    queryType: "metric",
    datasourceUid: lokiDatasourceUid,
    startTime: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
    endTime: now.toISOString(),
  };
  const raw = await withTimeoutAndAbort(tool, args, signal, queryTimeoutMs);
  if (raw === undefined) return { kind: "error", value: Number.NaN };
  const value = scalarFromPromResult(raw);
  return Number.isFinite(value)
    ? { kind: "ok", value }
    : { kind: "empty", value: Number.NaN };
}

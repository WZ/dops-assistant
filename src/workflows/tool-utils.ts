/**
 * Tool utility helpers for investigation workflow agents.
 *
 * Exports:
 *   - wrapToolsWithCallbacks — wrap tool execute functions with onToolCall callbacks
 *   - buildTimeWindowHint — build a time window hint string for evidence agent prompts
 *   - buildServiceContextHint — build a service context hint for evidence agent prompts
 *   - debug — conditional debug logger
 */

import type { WorkflowConfig } from "./investigation.js";
import { extractTimeRange, suggestStepSeconds, toRfc3339Window } from "./helpers.js";
import type { ServiceConfig } from "../config/schema.js";
import { getTimeContext } from "../agents/shared/time-context.js";
import { createLogger } from "../logger.js";

const coercionLogger = createLogger("tool-coercion");

// ── Debug logger (no-op in production; set DOPS_DEBUG=1 to enable) ───────────
export const debug = process.env.DOPS_DEBUG ? (...args: unknown[]) => console.error("[INVESTIGATION]", ...args) : (..._args: unknown[]) => {};

// ── Tool wrapping helper ──────────────────────────────────────────────────────

/**
 * Convert Grafana-style relative time ("now", "now-1h", "now-7d") to RFC3339.
 */
function resolveGrafanaTime(value: string): string {
  const now = Date.now();
  if (value === "now") return new Date(now).toISOString();
  const m = value.match(/^now-(\d+)([smhdw])$/);
  if (!m) return value; // already RFC3339 or unknown format
  const [, amt, unit] = m;
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return new Date(now - Number(amt) * (multipliers[unit!] ?? 0)).toISOString();
}

/** Shared check: does a property name look like a time field? */
function isTimeField(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes("time") || k.includes("rfc3339") || k.includes("start") || k.includes("end");
}

/**
 * Coerce tool arguments to match expected schema types.
 * LLMs often pass strings where arrays are expected (e.g., matches: "{...}" instead of ["{...}"]).
 */
export function coerceToolArgs(args: Record<string, unknown>, toolSchema: any): Record<string, unknown> {
  if (!toolSchema?.properties) return args;
  const coerced = { ...args };
  for (const [key, value] of Object.entries(coerced)) {
    const prop = toolSchema.properties[key];
    if (prop?.type === "array" && typeof value === "string") {
      coerced[key] = [value];
    } else if (prop?.type === "number" && typeof value === "string") {
      const num = Number(value);
      if (!isNaN(num)) coerced[key] = num;
    }
    // Convert "now", "now-1h" etc. to RFC3339 for time fields
    if (typeof value === "string" && /^now(?:-\d+[smhdw])?$/.test(value) && isTimeField(key)) {
      coerced[key] = resolveGrafanaTime(value);
    }
    // Normalize malformed RFC3339 that LLMs produce on time fields:
    //   "2026-04-15T20:27:00.Z"    → "2026-04-15T20:27:00Z"   (empty fraction + dot — INVALID)
    //   "2026-04-15T20:27:00."     → "2026-04-15T20:27:00Z"   (dangling dot, no Z)
    //   "2026-04-15T20:27:00"      → "2026-04-15T20:27:00Z"   (missing Z entirely)
    // Note: "2026-04-15T20:27:00.000Z", ".0Z", ".00Z" etc. are all VALID RFC3339
    // (zero fraction of second), so leave them alone. Only the empty-fraction
    // case (bare dot before Z) is malformed.
    const current = coerced[key];
    if (typeof current === "string" && isTimeField(key)) {
      let cleaned = current;
      // Empty fraction + Z: "20:27:00.Z" → "20:27:00Z"
      cleaned = cleaned.replace(/\.Z$/, "Z");
      // Dangling dot at the end (no Z at all): "20:27:00." → "20:27:00Z"
      cleaned = cleaned.replace(/\.$/, "Z");
      // Naive RFC3339-looking string missing its Z: "20:27:00" → "20:27:00Z"
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(cleaned)) {
        cleaned += "Z";
      }
      if (cleaned !== current) coerced[key] = cleaned;
    }
  }
  return coerced;
}

/**
 * Fill in Grafana query_prometheus time arguments that LLMs default to null.
 *
 * The Grafana MCP tool's schema requires startTime/endTime as strings and
 * stepSeconds as a number — even for instant queries where these are logically
 * meaningless. LLMs pass null for them on instant queries, which fails schema
 * validation and costs a retry round-trip. Default to "now" / 0 so the request
 * goes through on the first attempt. The "now" string is then converted to
 * RFC3339 by coerceToolArgs in the normal path.
 */
export function coercePrometheusArgs(args: Record<string, unknown>): Record<string, unknown> {
  const coerced = { ...args };
  if (coerced.startTime == null) coerced.startTime = "now";
  if (coerced.endTime == null) coerced.endTime = "now";
  if (coerced.stepSeconds == null) coerced.stepSeconds = 0;
  if (coerced.queryType == null) coerced.queryType = "instant";
  return coerced;
}

/**
 * Override Loki query parameters that LLMs consistently get wrong.
 *
 * The gpt-oss-120b model always sends direction:"forward" (oldest-first) and limit:20,
 * which causes investigations to miss recent errors buried past the first 20 entries.
 * Force backward (newest-first) and a minimum limit of 50 so error evidence surfaces.
 */
export function coerceLokiArgs(args: Record<string, unknown>): Record<string, unknown> {
  const coerced = { ...args };
  // stepSeconds is a Prometheus concept — Loki's query_loki_logs doesn't accept it.
  // LLMs consistently pass it; drop it so the tool call isn't rejected.
  delete coerced.stepSeconds;
  // Always use backward (newest-first) — errors at the end of a window are more relevant
  if (coerced.direction === "forward" || !coerced.direction) {
    coerced.direction = "backward";
  }
  // Minimum limit of 50 — 20 is too low for multi-minute incidents
  // Handle both number and string-typed limit (LLMs sometimes send "20" instead of 20)
  const limit = typeof coerced.limit === "string" ? Number(coerced.limit) : coerced.limit;
  if (typeof limit === "number" && !isNaN(limit) && limit < 50) {
    coerced.limit = 50;
  }
  return coerced;
}

/**
 * Strip MCP provider prefix from tool name (e.g. "grafana_query_prometheus" → "query_prometheus").
 * The frontend expects unprefixed tool names for chart rendering and display.
 */
function stripToolPrefix(name: string): string {
  const idx = name.indexOf("_");
  return idx > 0 ? name.slice(idx + 1) : name;
}

/**
 * Unwrap MCP content wrapper to get raw result text.
 * Mastra MCP tools return { content: [{ type: "text", text: "..." }] }.
 * The frontend expects raw JSON strings for chart parsing.
 */
export function truncateMcpResult(result: unknown, maxChars: number): unknown {
  if (!result || typeof result !== "object") return result;
  const content = (result as any).content;
  if (!Array.isArray(content)) return result;
  const truncated = content.map((part: any) => {
    if (part?.type === "text" && typeof part.text === "string" && part.text.length > maxChars) {
      return { ...part, text: part.text.slice(0, maxChars) + `\n... (truncated from ${part.text.length} chars)` };
    }
    return part;
  });
  return { ...result, content: truncated };
}

function unwrapMcpResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const content = (result as any).content;
    if (Array.isArray(content) && content.length > 0 && content[0]?.type === "text") {
      return content[0].text;
    }
  }
  return JSON.stringify(result);
}

/**
 * The symbol Mastra's Tool class uses to identify its own instances. We strip
 * this from wrapped tools so Mastra's CoreToolBuilder treats them as Vercel
 * tools and skips its input schema validation — otherwise the LLM's `null`
 * args for instant Prometheus queries get rejected by Mastra BEFORE our
 * execute runs, defeating the whole point of coercePrometheusArgs.
 * See: node_modules/@mastra/core/dist/chunk-FNVUZ3S2.js createExecute().
 */
const MASTRA_TOOL_MARKER = Symbol.for("mastra.core.tool.Tool");

/**
 * Wrap each tool's execute function to emit onToolCall before/after invocation.
 * If no onToolCall callback is provided, tools are returned unchanged.
 *
 * Intentionally strips the Mastra tool marker so Mastra's framework treats the
 * wrapped object as a Vercel/AI-SDK tool. This bypasses Mastra's
 * validateToolInput step, which is what lets our coercion hooks actually run
 * before the underlying MCP tool is invoked. The Vercel path still runs output
 * validation, so we also drop outputSchema to avoid false negatives on the
 * permissive MCP response shape.
 */
export function wrapToolsWithCallbacks(
  tools: Record<string, any>,
  onToolCall?: WorkflowConfig["onToolCall"],
  phase?: string,
  datasourceUidMap?: Map<string, string>,
  maxToolResultChars?: number,
): Record<string, any> {
  const needsDatasourceCoercion = (n: string) =>
    n.includes("query_prometheus") || n.includes("query_loki") ||
    n.includes("list_prometheus") || n.includes("list_loki");

  const wrapped: Record<string, any> = {};
  for (const [name, tool] of Object.entries(tools)) {
    // Spread everything, then explicitly drop the Mastra class marker and
    // the output schema. inputSchema stays so the LLM-facing tool spec is
    // unchanged — only the server-side input validation is bypassed.
    const { outputSchema: _outputSchema, ...toolRest } = tool;
    const wrappedTool: Record<string | symbol, any> = { ...toolRest };
    // Spread copies symbol-keyed properties; delete the marker explicitly.
    delete wrappedTool[MASTRA_TOOL_MARKER];
    wrapped[name] = {
      ...wrappedTool,
      execute: async (...execArgs: any[]) => {
        // Intercept hallucinated datasource short names (e.g. "prometheus" instead
        // of the real UID). Runs first so all downstream coercers see the correct UID.
        if (datasourceUidMap?.size && needsDatasourceCoercion(name) &&
            execArgs[0] && typeof execArgs[0] === "object") {
          const args = execArgs[0] as Record<string, unknown>;
          const uid = args["datasourceUid"];
          if (typeof uid === "string" && datasourceUidMap.has(uid)) {
            const realUid = datasourceUidMap.get(uid)!;
            if (realUid !== uid) {
              args["datasourceUid"] = realUid;
              coercionLogger.info(
                { phase, tool: name, from: uid, to: realUid },
                `Coerced datasourceUid: ${uid} → ${realUid}`,
              );
            }
          }
        }
        // Fill null prometheus time args BEFORE schema coercion — LLMs send null
        // on instant queries but the MCP schema requires strings, wasting a retry.
        if (name.includes("query_prometheus") && execArgs[0] && typeof execArgs[0] === "object") {
          execArgs[0] = coercePrometheusArgs(execArgs[0] as Record<string, unknown>);
        }
        // Coerce args to match schema (fixes LLM type mismatches)
        if (execArgs[0] && typeof execArgs[0] === "object" && tool.inputSchema) {
          execArgs[0] = coerceToolArgs(execArgs[0], tool.inputSchema);
        }
        // Fix Loki log query parameters that models consistently get wrong
        // Scoped to query_loki_logs only — stats/patterns tools may need different defaults
        if (name.includes("query_loki_logs") && execArgs[0] && typeof execArgs[0] === "object") {
          execArgs[0] = coerceLokiArgs(execArgs[0] as Record<string, unknown>);
        }
        const start = Date.now();
        try {
          let result = await tool.execute(...execArgs);
          if (maxToolResultChars) result = truncateMcpResult(result, maxToolResultChars);
          const resultStr = unwrapMcpResult(result);
          onToolCall?.(stripToolPrefix(name), execArgs[0] ?? {}, resultStr, Date.now() - start, undefined, phase);
          return result;
        } catch (err) {
          onToolCall?.(stripToolPrefix(name), execArgs[0] ?? {}, undefined, Date.now() - start, String(err), phase);
          throw err;
        }
      },
    };
  }
  return wrapped;
}

// ── Tool selection ───────────────────────────────────────────────────────────
// Tool scoping is provider-agnostic: role-based routing (getToolsByRole) selects
// which providers contribute tools, and the provider-level `enabledTools` config
// filters which tools each MCP server exposes. No hardcoded tool-name allowlists.

/**
 * Build a time window hint string for evidence agent prompts.
 * When resolvedTimeRange is provided (from LLM extraction), uses it directly.
 * Otherwise falls back to regex-based extractTimeRange.
 */
export function buildTimeWindowHint(anomalySummary: string, userMessage?: string, resolvedTimeRange?: { from: string; to: string }): string {
  const timeContext = getTimeContext();
  const timeRange = resolvedTimeRange ?? extractTimeRange(anomalySummary, userMessage);
  const stepSeconds = suggestStepSeconds(timeRange);
  const rfc3339 = toRfc3339Window(timeRange);

  return [
    timeContext,
    `INVESTIGATION TIME WINDOW: from="${timeRange.from}" to="${timeRange.to}"`,
    `You MUST query this full window as your FIRST tool call to see trends over time.`,
    `Suggested parameters: start="${timeRange.from}", end="${timeRange.to}", step/interval=${stepSeconds}s`,
    `Do NOT only check the current instant value — past anomalies are invisible to point-in-time queries.`,
    `Time window in RFC3339: start="${rfc3339.startRfc3339}", end="${rfc3339.endRfc3339}"`,
  ].join("\n");
}

/**
 * Build a service context hint for evidence agent prompts.
 * Injects configured metric queries and log search parameters from the matching service config.
 */
export function buildServiceContextHint(services: ServiceConfig[], serviceName?: string): { metricsHint: string; logLabelsHint: string } {
  if (!serviceName) return { metricsHint: "", logLabelsHint: "" };
  const service = services.find((s) => s.name === serviceName);
  if (!service) return { metricsHint: "", logLabelsHint: "" };

  let metricsHint = "";
  if (service.metrics.length > 0) {
    const metricList = service.metrics.map((m) => `- ${m.description}: \`${m.query}\``).join("\n");
    metricsHint = `SERVICE METRICS TO CHECK:\n${metricList}`;
  }

  let logLabelsHint = "";
  if (Object.keys(service.logLabels).length > 0) {
    logLabelsHint = `SERVICE LOG LABELS: ${JSON.stringify(service.logLabels)}`;
  }

  return { metricsHint, logLabelsHint };
}

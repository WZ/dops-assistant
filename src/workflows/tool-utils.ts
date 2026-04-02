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

/**
 * Coerce tool arguments to match expected schema types.
 * LLMs often pass strings where arrays are expected (e.g., matches: "{...}" instead of ["{...}"]).
 */
function coerceToolArgs(args: Record<string, unknown>, toolSchema: any): Record<string, unknown> {
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
    if (typeof value === "string" && /^now(?:-\d+[smhdw])?$/.test(value) &&
        (key.toLowerCase().includes("time") || key.toLowerCase().includes("rfc3339") ||
         key.toLowerCase().includes("start") || key.toLowerCase().includes("end"))) {
      coerced[key] = resolveGrafanaTime(value);
    }
  }
  return coerced;
}

/**
 * Override Loki query parameters that LLMs consistently get wrong.
 *
 * The gpt-oss-120b model always sends direction:"forward" (oldest-first) and limit:20,
 * which causes investigations to miss recent errors buried past the first 20 entries.
 * Force backward (newest-first) and a minimum limit of 50 so error evidence surfaces.
 */
function coerceLokiArgs(args: Record<string, unknown>): Record<string, unknown> {
  const coerced = { ...args };
  // Always use backward (newest-first) — errors at the end of a window are more relevant
  if (coerced.direction === "forward" || !coerced.direction) {
    coerced.direction = "backward";
  }
  // Minimum limit of 50 — 20 is too low for multi-minute incidents
  if (typeof coerced.limit === "number" && coerced.limit < 50) {
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
 * Wrap each tool's execute function to emit onToolCall before/after invocation.
 * If no onToolCall callback is provided, tools are returned unchanged.
 */
export function wrapToolsWithCallbacks(
  tools: Record<string, any>,
  onToolCall?: WorkflowConfig["onToolCall"],
  phase?: string,
): Record<string, any> {
  const wrapped: Record<string, any> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = {
      ...tool,
      execute: async (...execArgs: any[]) => {
        // Coerce args to match schema (fixes LLM type mismatches)
        if (execArgs[0] && typeof execArgs[0] === "object" && tool.inputSchema) {
          execArgs[0] = coerceToolArgs(execArgs[0], tool.inputSchema);
        }
        // Fix Loki query parameters that models consistently get wrong
        if (name.includes("query_loki") && execArgs[0] && typeof execArgs[0] === "object") {
          execArgs[0] = coerceLokiArgs(execArgs[0] as Record<string, unknown>);
        }
        const start = Date.now();
        try {
          const result = await tool.execute(...execArgs);
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

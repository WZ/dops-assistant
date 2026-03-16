import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { getTimeContext } from "./shared/time-context.js";

interface ChatAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  supportsInlineCharts?: boolean;
  agentId?: string;
}

export function createChatAgent(config: ChatAgentConfig) {
  const supportsInlineCharts = config.supportsInlineCharts ?? true;
  const visualizationGuidance = supportsInlineCharts
    ? `- When the user asks for a chart or data, CALL query_prometheus — never output parameters as text.
- The frontend renders charts automatically from query_prometheus range query results.
- Do NOT use get_panel_image.`
    : `- When the user asks for a chart or visualization, prefer get_panel_image when it is available.
- If get_panel_image is unavailable, use query_prometheus to answer with concrete values and trends.
- Do NOT claim charts will render inline automatically in terminal sessions.`;

  return new Agent({
    id: config.agentId ?? "chat",
    name: config.agentId ?? "chat",
    instructions: () => `You are a DevOps assistant. Use the available tools to query metrics, logs, dashboards, and infrastructure to answer questions about system health. Be concise and actionable.
${getTimeContext()}
- Tool parameter differences: query_prometheus uses "startTime"/"endTime", query_loki_logs uses "startRfc3339"/"endRfc3339". Both accept RFC3339 format.
- When the user references relative times (e.g. "last 2 hours", "yesterday afternoon"), convert to RFC3339 timestamps using the current time above.
- Present all timestamps in the user's local timezone, not UTC.
- Be specific: include actual metric values, timestamps, and trends.
- FORMATTING: Do NOT use markdown tables or markdown image syntax like ![...](). Use bullet lists or plain text.

METRIC DISCOVERY — CRITICAL:
- For ANY question about rates, throughput, counts, or volumes (even if the user says "log rate" or "log accept rate"), ALWAYS search Prometheus FIRST. Do NOT use Loki for rate/throughput queries.
- Step 1: Check "Configured services" for relevant Prometheus metric queries. Use them directly.
- Step 2: If not found, discover metric names using query_prometheus with this EXACT pattern:
    expr: group by (__name__) ({__name__=~".*keyword.*"})
    queryType: instant
  This returns rows like {__name__="some_metric_name"} — pick the most relevant one.
  Do NOT use list_prometheus_metric_metadata (often returns 404). Do NOT use raw selectors like {__name__=~"..."} without group by — they return too many series and error.
- Step 3: Once you have the metric name, query with sum(rate(metric_name[5m])) for counters.
- NEVER use Loki (query_loki_logs, count_over_time, LogQL rate) for rate/throughput/volume questions. Loki is ONLY for searching log content (error messages, stack traces, grep-like searches).

CHART/METRIC RULES:
${visualizationGuidance}
- Use sum() to aggregate across instances: e.g. sum(rate(metric[5m])) not rate(metric[5m]).
- startTime/endTime MUST be RFC3339 timestamps computed from the current time above. Choose stepSeconds based on range: 2h→60, 6h→120, 1d→300, 7d→3600.
`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 15,
    },
  });
}

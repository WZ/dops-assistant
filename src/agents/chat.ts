import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { getTimeContext } from "../agent/prompts.js";

interface ChatAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
}

export function createChatAgent(config: ChatAgentConfig) {
  return new Agent({
    id: "chat",
    name: "chat",
    instructions: () => `You are a DevOps assistant. Use the available tools to query metrics, logs, dashboards, and infrastructure to answer questions about system health. Be concise and actionable.
${getTimeContext()}
- Tool parameter differences: query_prometheus uses "startTime"/"endTime", query_loki_logs uses "startRfc3339"/"endRfc3339". Both accept RFC3339 format.
- When the user references relative times (e.g. "last 2 hours", "yesterday afternoon"), convert to RFC3339 timestamps using the current time above.
- Present all timestamps in the user's local timezone, not UTC.
- Be specific: include actual metric values, timestamps, and trends.
- FORMATTING: Do NOT use markdown tables or markdown image syntax like ![...](). Use bullet lists or plain text.

CHART/METRIC RULES:
- When the user asks for a chart or data, CALL query_prometheus — never output parameters as text.
- The frontend renders charts automatically from query_prometheus range query results.
- Use sum() to aggregate across instances: e.g. sum(rate(metric[5m])) not rate(metric[5m]).
- startTime/endTime MUST be RFC3339 timestamps computed from the current time above. Choose stepSeconds based on range: 2h→60, 6h→120, 1d→300, 7d→3600.
- Do NOT use get_panel_image.`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 15,
    },
  });
}

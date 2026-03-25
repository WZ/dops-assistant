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
    ? `- When the user asks for a chart or data, use metric query tools directly — never output parameters as text.
- The frontend renders charts automatically from metric range query results.`
    : `- When the user asks for a chart or visualization, prefer dashboard image tools when available.
- If no image tool is available, use metric query tools to answer with concrete values and trends.
- Do NOT claim charts will render inline automatically in terminal sessions.`;

  return new Agent({
    id: config.agentId ?? "chat",
    name: config.agentId ?? "chat",
    instructions: () => `You are a DevOps assistant. Use the available tools to query metrics, logs, dashboards, and infrastructure to answer questions about system health. Be concise and actionable.
${getTimeContext()}
- When the user references relative times (e.g. "last 2 hours", "yesterday afternoon"), convert to RFC3339 timestamps using the current time above.
- Present all timestamps in the user's local timezone, not UTC.
- Be specific: include actual metric values, timestamps, and trends.
- FORMATTING: Do NOT use markdown tables or markdown image syntax like ![...](). Use bullet lists or plain text.

METRIC DISCOVERY — CRITICAL:
- For ANY question about rates, throughput, counts, or volumes, ALWAYS use metric query tools FIRST. Do NOT use log search tools for rate/throughput queries.
- Step 1: Check "Configured services" for relevant metric queries. Use them directly.
- Step 2: If not found, use available metric discovery or listing tools to find relevant metric names.
- Step 3: Once you have the metric name, query it with appropriate aggregation for the metric type.
- Log search tools are ONLY for searching log content (error messages, stack traces, grep-like searches), not for rate/throughput/volume analysis.

CHART/METRIC RULES:
${visualizationGuidance}
- Use aggregation functions to combine across instances when available.
- Time parameters should use RFC3339 format. Choose appropriate step/interval based on time range.
`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 15,
      modelSettings: { temperature: 0.3 },
    },
  });
}

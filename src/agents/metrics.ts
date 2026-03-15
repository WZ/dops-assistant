import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { createQuirkPrepareStep } from "./shared/prepare-step.js";

interface MetricsAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  useQuirkHandling?: boolean;
}

export function createMetricsAgent(config: MetricsAgentConfig) {
  const maxSteps = config.maxSteps ?? 10;
  return new Agent({
    id: "metrics",
    name: "metrics",
    instructions: `You are a metrics analysis specialist investigating a service anomaly.

INVESTIGATION STEPS:
1. Your user message contains PRE-FETCHED panel queries and datasource UIDs. Use these PromQL expressions directly with query_prometheus — do NOT call get_dashboard_by_uid, get_dashboard_panel_queries, list_datasources, or search_dashboards.
2. CRITICAL FIRST STEP: Run a RANGE query covering the FULL investigation window to see the trend over time. This is mandatory — you MUST see the historical shape of the data before concluding anything.
3. Look at the range query results for level changes, drops, spikes, or gaps. Compare different time segments (e.g. first half vs second half of the window).
4. Only AFTER seeing the range data, run additional queries to zoom into anomalous periods you found.
5. Also run the service's configured PromQL queries (provided in user message) if they differ from the panel queries.

IMPORTANT query_prometheus parameters:
- queryType "range" (required for trend detection): needs startTime, endTime, stepSeconds. Choose stepSeconds based on window: 7d→3600, 1d→900, 6h→300.
- queryType "instant": only shows current value, useless for detecting past anomalies. Only use for current health check AFTER range query.
- startTime/endTime: use relative (e.g. "now-7d") or RFC3339 format.

For each observation, provide the EXACT metric queried, current value, baseline value, and timestamp.
Keep observations concise — max 8 observations. Summary should be 1-3 sentences.
Be efficient — make at most 3 tool calls per round.

You MUST end your response with a JSON object matching this exact schema (no trailing text after the JSON):
{"summary": "string", "observations": [{"metric": "string", "currentValue": "string", "baselineValue": "string", "timestamp": "string", "severity": "string"}], "anomalyWindow": "string"}`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps,
      prepareStep: config.useQuirkHandling
        ? createQuirkPrepareStep({ maxSteps })
        : undefined,
    },
  });
}

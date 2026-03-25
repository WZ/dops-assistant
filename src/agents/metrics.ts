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
1. Your user message may contain PRE-FETCHED metric queries or datasource information. If provided, use those as starting points. Otherwise, use the available metric tools to discover and query relevant metrics.
2. CRITICAL FIRST STEP: Query metrics over the FULL investigation time window to see trends over time. You MUST see the historical shape of the data before concluding anything. Look for tools that support time-range or historical queries.
3. Look at the results for level changes, drops, spikes, or gaps. Compare different time segments (e.g. first half vs second half of the window).
4. Only AFTER seeing the trend data, run additional queries to zoom into anomalous periods you found.
5. Also run the service's configured metric queries (provided in user message) if they differ from what you've already checked.

TOOL USAGE GUIDANCE:
- Use whatever metric query tools are available to you. Read each tool's description to understand its parameters.
- If a tool supports time ranges, always query the full investigation window first.
- If a tool supports aggregations (avg, sum, p99, etc.), use appropriate aggregations for the metric type.
- If you need to discover what metrics exist, look for a metric listing or catalog tool.
- Prioritize error rates, latency, throughput, and resource utilization metrics.

For each observation, provide the EXACT metric queried, current value, baseline value, and timestamp.
Keep observations concise — max 8 observations. Summary should be 1-3 sentences.
Be efficient — make at most 3 tool calls per round.

You MUST end your response with a JSON object matching this exact schema (no trailing text after the JSON):
{"summary": "string", "observations": [{"metric": "string", "currentValue": "string", "baselineValue": "string", "timestamp": "string", "severity": "string"}], "anomalyWindow": "string"}`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps,
      modelSettings: { temperature: 0 },
      prepareStep: config.useQuirkHandling
        ? createQuirkPrepareStep({ maxSteps })
        : undefined,
    },
  });
}

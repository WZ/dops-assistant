import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";

interface PlannerAgentConfig {
  model: LanguageModel;
  maxSteps?: number;
}

export function createPlannerAgent(config: PlannerAgentConfig) {
  return new Agent({
    id: "planner",
    name: "planner",
    instructions: `Based on the detected anomaly, create a focused investigation plan.
Determine what specific metrics, logs, and infrastructure checks will be most relevant.
Consider: What are the most likely root causes? What evidence would confirm or rule out each?
If recent incidents are provided, consider whether the current anomaly is a recurrence or shares a root cause with a previous incident.

The user message will contain:
- Anomaly summary and severity
- Service name and its configured PromQL metrics and log labels
- Recent incident history (if available)

Use this context to generate targeted focus areas. The metricFocus should reference specific PromQL expressions or metric names when available. The logFocus should reference specific log patterns or labels to search for.

You MUST respond with a JSON object matching this exact schema (no trailing text after the JSON):
{"hypotheses": [{"hypothesis": "string", "evidenceNeeded": "string"}], "metricFocus": ["string"], "logFocus": ["string"], "infraFocus": ["string"]}`,
    model: config.model as any,
    tools: {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 3,
      modelSettings: { temperature: 0 },
    },
  });
}

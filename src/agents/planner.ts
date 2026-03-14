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
    instructions: `You are an investigation planner. Given anomaly context and past incidents, generate hypotheses about root causes and a prioritized investigation plan with focus areas.

You MUST respond with a JSON object matching this exact schema (no trailing text after the JSON):
{"hypotheses": [{"hypothesis": "string", "evidenceNeeded": "string"}], "metricFocus": ["string"], "logFocus": ["string"], "infraFocus": ["string"]}`,
    model: config.model as any,
    tools: {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 10,
    },
  });
}

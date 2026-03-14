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
    instructions: `You are an investigation planner. Given anomaly context and past incidents, generate hypotheses about root causes and a prioritized investigation plan with focus areas.`,
    model: config.model as any,
    tools: {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 10,
    },
  });
}

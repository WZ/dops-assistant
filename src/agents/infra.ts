import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { createQuirkPrepareStep } from "./shared/prepare-step.js";

interface InfraAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  useQuirkHandling?: boolean;
}

export function createInfraAgent(config: InfraAgentConfig) {
  const maxSteps = config.maxSteps ?? 10;
  return new Agent({
    id: "infra",
    name: "infra",
    instructions: `You are an infrastructure health specialist. Check infrastructure metrics for resource exhaustion, scaling issues, network problems, and deployment changes.`,
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

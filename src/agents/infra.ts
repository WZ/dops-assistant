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
    instructions: `You are an infrastructure health specialist. Check infrastructure metrics for resource exhaustion, scaling issues, network problems, and deployment changes.

You MUST end your response with a JSON object matching this exact schema (no trailing text after the JSON):
{"summary": "string", "observations": [{"resource": "string", "status": "string", "detail": "string", "timestamp": "string"}]}`,
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

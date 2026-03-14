import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { createQuirkPrepareStep } from "./shared/prepare-step.js";

interface LogsAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  useQuirkHandling?: boolean;
}

export function createLogsAgent(config: LogsAgentConfig) {
  const maxSteps = config.maxSteps ?? 10;
  return new Agent({
    id: "logs",
    name: "logs",
    instructions: `You are a log analysis specialist. Query log tools to find error patterns, exceptions, and log anomalies correlated with the incident timeline.`,
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

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
    instructions: `You are a metrics analysis specialist. Query Prometheus/metrics tools to deep-dive into metric anomalies. Identify correlations, trends, and anomalous patterns.`,
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

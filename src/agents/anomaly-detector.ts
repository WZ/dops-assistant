import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { createQuirkPrepareStep } from "./shared/prepare-step.js";

interface AnomalyDetectorAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  useQuirkHandling?: boolean;
}

/**
 * Extract investigation time window from a user message.
 * Returns ISO8601 from/to strings defaulting to the last 8 hours if no time
 * reference can be found.
 */
export function extractTimeRangeViaLlm(userMessage: string): { from: string; to: string } {
  const now = new Date();
  // Static fallback: parse simple relative expressions or default to last 8 hours
  const match = userMessage.match(/last\s+(\d+)\s*(hour|hr|h|day|d)/i);
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const ms = unit.startsWith("d") ? n * 86400000 : n * 3600000;
    return {
      from: new Date(now.getTime() - ms).toISOString(),
      to: now.toISOString(),
    };
  }
  return {
    from: new Date(now.getTime() - 8 * 3600000).toISOString(),
    to: now.toISOString(),
  };
}

export function createAnomalyDetectorAgent(config: AnomalyDetectorAgentConfig) {
  const maxSteps = config.maxSteps ?? 10;
  return new Agent({
    id: "anomaly-detector",
    name: "anomaly-detector",
    instructions: `You are an anomaly detection specialist. Analyze metrics and dashboards to identify anomalies. Report the time range, severity, affected services, and summary of anomalies found.

You MUST end your response with a JSON object matching this exact schema (no trailing text after the JSON):
{"isAnomaly": boolean, "severity": "low"|"medium"|"high"|"critical", "summary": "string", "affectedServices": ["string"]}`,
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

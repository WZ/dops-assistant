import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";

interface SynthesisAgentConfig {
  model: LanguageModel;
  maxSteps?: number;
}

export function createSynthesisAgent(config: SynthesisAgentConfig) {
  return new Agent({
    id: "synthesis",
    name: "synthesis",
    instructions: `You are an RCA synthesis specialist. Given metric findings, log findings, and infrastructure findings, synthesize a root cause analysis. Identify the root cause, trigger, contributing factors, and recommendations. Validate your findings for consistency before finalizing.

You MUST respond with a JSON object matching this exact schema (no trailing text after the JSON):
{"severity": "low"|"medium"|"high"|"critical", "summary": "string", "rootCause": "string", "trigger": "string", "confidence": "low"|"medium"|"high", "confidenceScore": number}`,
    model: config.model as any,
    tools: {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 10,
    },
  });
}

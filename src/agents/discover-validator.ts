import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import type { ServiceConfig } from "../config/schema.js";

export interface ValidatorAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  servicesToValidate: ServiceConfig[];
  maxSteps?: number;
}

export function createValidatorAgent(config: ValidatorAgentConfig) {
  const serviceList = JSON.stringify(config.servicesToValidate, null, 2);

  return new Agent({
    id: "discover-validator",
    name: "discover-validator",
    instructions: () => `You are a service validation agent. You have been given a list of discovered services. Your job is to VERIFY each one by actually querying the monitoring tools.

## Services to Validate

${serviceList}

## Process

For each service:
1. Execute its metric query — does it return data?
2. If it has logLabels, query the log system using those labels — do results come back?
3. Classify the service:
   - "verified" — both metrics and logs returned data (or metrics returned data and no logLabels defined)
   - "partial" — one of metrics/logs worked but the other didn't
   - "unverified" — metrics query returned no data

## Output Format

Return a JSON array. Each entry must have ALL original fields plus:
- "confidence": "verified" | "partial" | "unverified"
- "validationNotes": a short string explaining what was checked (e.g., "metrics ✓ logs ✓" or "metrics ✗ no data returned")

Return the COMPLETE list — do not omit any services. Return valid JSON.`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 15,
    },
  });
}

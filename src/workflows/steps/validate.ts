import { createValidatorAgent } from "../../agents/discover-validator.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { getAllTools } from "../../mcp/provider.js";
import { wrapToolsWithCallbacks } from "../tool-utils.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { OnToolCallEnriched, OnIteration } from "../../types/agent-interfaces.js";

export interface ValidateStepConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  services: ServiceConfig[];
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
}

export async function runValidateStep(config: ValidateStepConfig): Promise<ValidatedServiceConfig[]> {
  const rawTools = await getAllTools(config.providers).catch(() => ({}));
  const tools = config.onToolCall
    ? wrapToolsWithCallbacks(rawTools, config.onToolCall, "validation")
    : rawTools;

  const agent = createValidatorAgent({
    model: config.model,
    tools,
    servicesToValidate: config.services,
    maxSteps: 15,
  });

  const result = await agent.generate("Validate each service by querying its metrics and log labels. Return the complete annotated list as JSON.");

  const parsed = safeJsonParse(result.text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed?.services && Array.isArray(parsed.services)) return parsed.services;

  // Fallback: return all services as unverified
  return config.services.map((s) => ({
    ...s,
    confidence: "unverified" as const,
    validationNotes: "validation agent did not return structured output",
  }));
}

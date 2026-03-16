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

  const maxSteps = Math.max(40, config.services.length * 3);
  const agent = createValidatorAgent({
    model: config.model,
    tools,
    servicesToValidate: config.services,
    maxSteps,
    useQuirkHandling: true,
  });

  console.error(`[VALIDATE] Starting validation of ${config.services.length} services with ${Object.keys(tools).length} tools`);

  let result;
  try {
    result = await agent.generate("Validate each service by querying its metrics and log labels. Return the complete annotated list as JSON.");
  } catch (err) {
    console.error(`[VALIDATE] Agent threw error:`, err instanceof Error ? err.message : err);
    return config.services.map((s) => ({
      ...s,
      confidence: "unverified" as const,
      validationNotes: "validation agent error",
    }));
  }

  console.error(`[VALIDATE] Agent returned ${result.text?.length ?? 0} chars`);
  if (result.text) {
    console.error(`[VALIDATE] Response preview: ${result.text.slice(0, 500)}`);
  }

  const parsed = safeJsonParse(result.text);
  if (Array.isArray(parsed)) {
    console.error(`[VALIDATE] Parsed ${parsed.length} validated services`);
    return parsed;
  }
  if (parsed?.services && Array.isArray(parsed.services)) {
    console.error(`[VALIDATE] Parsed ${parsed.services.length} from .services`);
    return parsed.services;
  }

  console.error(`[VALIDATE] Failed to parse — falling back to unverified`);
  // Fallback: return all services as unverified
  return config.services.map((s) => ({
    ...s,
    confidence: "unverified" as const,
    validationNotes: "validation agent did not return structured output",
  }));
}

import { runDiscoverStep } from "./steps/discover.js";
import { runValidateStep } from "./steps/validate.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../mcp/provider.js";
import type { DiscoveryConfig } from "../config/schema.js";
import type { ValidatedServiceConfig } from "../types/discovery-types.js";
import type { OnToolCallEnriched, OnIteration } from "../types/agent-interfaces.js";

export interface DiscoveryWorkflowConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  onPhase?: (phase: string) => void;
  onIteration?: OnIteration;
  onToolCall?: OnToolCallEnriched;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

export async function runDiscovery(config: DiscoveryWorkflowConfig): Promise<ValidatedServiceConfig[]> {
  config.onPhase?.("discovery");
  const discovered = await runDiscoverStep({
    model: config.model,
    providers: config.providers,
    discoveryConfig: config.discoveryConfig,
    onToolCall: config.onToolCall,
    onIteration: config.onIteration,
    onTokenUsage: config.onTokenUsage,
  });

  if (discovered.length === 0) return [];

  config.onPhase?.("validation");
  const validated = await runValidateStep({
    providers: config.providers,
    services: discovered,
    onToolCall: config.onToolCall,
    onIteration: config.onIteration,
    onTokenUsage: config.onTokenUsage,
  });

  return validated;
}

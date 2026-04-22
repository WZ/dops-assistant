import { runDiscoverStep } from "./steps/discover.js";
import { runValidateStep } from "./steps/validate.js";
import { createLogger } from "../logger.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../mcp/provider.js";
import type { DiscoveryConfig } from "../config/schema.js";
import type { OnToolCallEnriched, OnIteration, DiscoveryResult } from "../types/agent-interfaces.js";
import type { Skill } from "../skills/store.js";

const logger = createLogger("discover");

export interface DiscoveryWorkflowConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  onPhase?: (phase: string) => void;
  onIteration?: OnIteration;
  onToolCall?: OnToolCallEnriched;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  onRetry?: (attempt: number, maxRetries: number, reason: string) => void;
  skills?: Skill[];
}

export async function runDiscovery(config: DiscoveryWorkflowConfig): Promise<DiscoveryResult> {
  config.onPhase?.("discovery");
  const discovered = await runDiscoverStep({
    model: config.model,
    providers: config.providers,
    discoveryConfig: config.discoveryConfig,
    onToolCall: config.onToolCall,
    onIteration: config.onIteration,
    onTokenUsage: config.onTokenUsage,
    onRetry: config.onRetry,
    skills: config.skills,
  });

  if (discovered.services.length === 0) {
    // Loud signal for the operator: an empty result here means the agent
    // either decided there were zero services OR it exhausted retries
    // without producing parseable JSON. runDiscoverStep already logs at
    // ERROR level when retries fail; this is the top-level marker so the
    // phase sequence doesn't silently skip validation. Surface the
    // discovered globalProbeRules too — discovery can succeed at writing
    // stack-aware globals even when the service sweep comes back empty
    // (the probe uses globals with `{service}` substitution against the
    // existing registry).
    logger.warn("discovery: no services produced, skipping validation phase");
    config.onPhase?.("complete-empty");
    return { services: [], globalProbeRules: discovered.globalProbeRules };
  }

  config.onPhase?.("validation");
  const validated = await runValidateStep({
    providers: config.providers,
    services: discovered.services,
    discoveryRecipes: config.discoveryConfig.discoveryRecipes,
    onToolCall: config.onToolCall,
    onIteration: config.onIteration,
    onTokenUsage: config.onTokenUsage,
  });

  return { services: validated, globalProbeRules: discovered.globalProbeRules };
}

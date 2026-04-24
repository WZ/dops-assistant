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
  // AP2: Terminal phase emit is wrapped in try/finally so the caller ALWAYS
  // gets a terminal signal, even when runValidateStep stalls or throws. A
  // validation failure falls back to the unverified discovered services so
  // `services.yaml` gets written instead of being lost to a mid-flow throw.
  let result: DiscoveryResult = { services: [], globalProbeRules: [] };
  let terminalPhase: "complete" | "complete-empty" | "complete-validation-failed" | "complete-failed" = "complete-failed";
  try {
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
      terminalPhase = "complete-empty";
      result = { services: [], globalProbeRules: discovered.globalProbeRules };
      return result;
    }

    // Seed the fallback result with the unverified discovered services in
    // case runValidateStep throws — the caller can still persist them.
    // Tag with confidence="unverified" + note so operators reading
    // services.yaml see clearly that validation never completed.
    result = {
      services: discovered.services.map((s) => ({
        ...s,
        confidence: "unverified" as const,
        validationNotes: "validation step did not run (discovery mid-flow fallback)",
      })),
      globalProbeRules: discovered.globalProbeRules,
    };

    config.onPhase?.("validation");
    try {
      const validated = await runValidateStep({
        providers: config.providers,
        services: discovered.services,
        discoveryRecipes: config.discoveryConfig.discoveryRecipes,
        onToolCall: config.onToolCall,
        onIteration: config.onIteration,
        onTokenUsage: config.onTokenUsage,
      });
      result = { services: validated, globalProbeRules: discovered.globalProbeRules };
      terminalPhase = "complete";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err: message, serviceCount: discovered.services.length },
        "discovery: validation step failed — returning unverified discovered services so services.yaml is still written",
      );
      terminalPhase = "complete-validation-failed";
    }
    return result;
  } finally {
    config.onPhase?.(terminalPhase);
  }
}

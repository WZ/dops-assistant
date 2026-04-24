import { runDiscoverStep } from "./steps/discover.js";
import { runValidateStep } from "./steps/validate.js";
import { createLogger } from "../logger.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../mcp/provider.js";
import type { DiscoveryConfig } from "../config/schema.js";
import type { OnToolCallEnriched, OnIteration, DiscoveryResult } from "../types/agent-interfaces.js";
import type { Skill } from "../skills/store.js";

const logger = createLogger("discover");

/**
 * Terminal discovery phases emitted by {@link runDiscovery}'s finally block.
 * Exported so the WS bridge (and any other observer) can identify the
 * terminal set without string-prefix matching against a drifting convention.
 */
export const TERMINAL_DISCOVERY_PHASES = [
  "complete",
  "complete-empty",
  "complete-validation-failed",
  "complete-failed",
] as const;
export type TerminalDiscoveryPhase = (typeof TERMINAL_DISCOVERY_PHASES)[number];

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
  let terminalPhase: TerminalDiscoveryPhase = "complete";
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
      return { services: [], globalProbeRules: discovered.globalProbeRules };
    }

    // Seed the fallback result with the unverified discovered services in
    // case runValidateStep throws — the caller can still persist them.
    // Tag with confidence="unverified" + note so operators reading
    // services.yaml see clearly that validation never completed.
    result = {
      services: discovered.services.map((s) => ({
        ...s,
        confidence: "unverified" as const,
        validationNotes: "validation did not complete (discovery mid-flow fallback)",
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
      // Preserve the full Error (including stack) via pino's default
      // `err` serializer rather than coercing to a string — losing the
      // stack here means the follow-up investigation starts blind.
      logger.warn(
        { err, serviceCount: discovered.services.length },
        "discovery: validation step failed — returning unverified discovered services so services.yaml is still written",
      );
      terminalPhase = "complete-validation-failed";
    }
    return result;
  } catch (err) {
    // Discovery (or an unexpected throw from the non-validation path)
    // failed. Surface a distinct terminal phase and re-throw so callers
    // keep their existing promise-rejection semantics.
    terminalPhase = "complete-failed";
    throw err;
  } finally {
    config.onPhase?.(terminalPhase);
  }
}

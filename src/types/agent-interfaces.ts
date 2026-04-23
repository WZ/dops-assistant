/**
 * Duck-typed interfaces for the chat and investigation agents.
 * These define the contracts that ws-handler.ts, App.tsx, and the
 * Mastra adapters all share — no dependency on concrete legacy classes.
 */

import type { ChatRequest, ChatResponse } from "./agent-types.js";
import type { RcaReport } from "./rca-types.js";
import type { ValidatedServiceConfig } from "./discovery-types.js";
import type { ServiceConfig, DiscoveryConfig, InvestigationTemplate, ProbeMetricRule } from "../config/schema.js";
import type { TokenUsage } from "./llm-types.js";
import type { Skill } from "../skills/store.js";

export interface IChatAgent {
  chat(task: ChatRequest): Promise<ChatResponse>;
}

export type OnToolCallEnriched = (
  name: string,
  args: Record<string, unknown>,
  result?: string,
  durationMs?: number,
  error?: string,
  phase?: string,
) => void;

export type OnIteration = (
  phase: string,
  iteration: number,
  maxIterations: number,
  description: string,
) => void;

export interface IInvestigationAgent {
  investigate(
    service: ServiceConfig,
    initialAnomaly: unknown,
    correlationId?: string,
    onTokenUsage?: (usage: TokenUsage) => void,
    userMessage?: string,
    onToolCall?: OnToolCallEnriched,
    onPhase?: (phase: string) => void,
    onIteration?: OnIteration,
    skillContext?: string,
    template?: InvestigationTemplate,
    readOnlyTools?: boolean,
    skills?: Skill[],
  ): Promise<RcaReport>;
}

/**
 * Structured discovery output. `services` is the per-service config the
 * validator produced (names, metrics, logLabels, optional probeRules).
 * `globalProbeRules` is the top-level stack-aware rule set the discovery
 * agent wrote after label-key introspection — applied to every registered
 * service by the probe. Empty array is a valid output ("stack matches the
 * hardcoded k8s defaults, no override needed").
 */
export interface DiscoveryResult {
  services: ValidatedServiceConfig[];
  globalProbeRules: ProbeMetricRule[];
}

export interface IDiscoverAgent {
  discover(
    config: DiscoveryConfig,
    onPhase?: (phase: string) => void,
    onIteration?: OnIteration,
    onToolCall?: OnToolCallEnriched,
    onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
    skills?: Skill[],
    onRetry?: (attempt: number, maxRetries: number, reason: string) => void,
  ): Promise<DiscoveryResult>;

  /**
   * Persist an accepted discovery result. When `globalProbeRules` is provided
   * (the typical discovery path), services and globals are written atomically
   * via `registryStore.saveAll()`. When omitted (manual UI edits, legacy
   * callers), services are saved via `registryStore.save()` and the existing
   * `globalProbeRules` in the file are preserved.
   */
  accept(
    services: ServiceConfig[],
    source: "discovery" | "manual",
    globalProbeRules?: ProbeMetricRule[],
  ): Promise<string>;
}

/**
 * Duck-typed interfaces for the chat and investigation agents.
 * These define the contracts that ws-handler.ts, App.tsx, and the
 * Mastra adapters all share — no dependency on concrete legacy classes.
 */

import type { ChatRequest, ChatResponse } from "./agent-types.js";
import type { RcaReport } from "./rca-types.js";
import type { ValidatedServiceConfig } from "./discovery-types.js";
import type { ServiceConfig, DiscoveryConfig, InvestigationTemplate } from "../config/schema.js";
import type { TokenUsage } from "./llm-types.js";

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
  ): Promise<RcaReport>;
}

export interface IDiscoverAgent {
  discover(
    config: DiscoveryConfig,
    onPhase?: (phase: string) => void,
    onIteration?: OnIteration,
    onToolCall?: OnToolCallEnriched,
    onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
  ): Promise<ValidatedServiceConfig[]>;

  accept(services: ServiceConfig[], source: "discovery" | "manual"): Promise<string>;
}

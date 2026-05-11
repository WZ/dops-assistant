import { extractMastraToolResult, type MastraToolResultLike } from "../../tool-utils.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../../../mcp/provider.js";
import type { DiscoveryConfig } from "../../../config/schema.js";
import type { OnToolCallEnriched, OnIteration } from "../../../types/agent-interfaces.js";
import type { Skill } from "../../../skills/store.js";
import type { LlmRetryConfig } from "../../../agents/shared/llm-retry.js";
import { LlmUnavailableError } from "../../../agents/shared/llm-errors.js";
import { getUsage } from "../../../agents/shared/llm-result.js";
import {
  createAbortError,
  throwIfAborted,
  isAbortError,
  isLlmTimeoutError,
  runWithHardTimeout,
  sleepWithBackoff,
} from "../../../agents/shared/llm-abort.js";

// Legacy names kept for backwards-compat with existing callers (validate.ts).
export const createDiscoveryAbortError = createAbortError;
export const throwIfDiscoveryAborted = throwIfAborted;
export { isAbortError };
import {
  RECOVERY_TOOL_RESULT_CHARS,
  runStallRecovery,
  type RecoveryToolEntry,
} from "./stall-recovery.js";
import { logLlmCall, logLlmCallStart, logToolCall, newCallId, type ToolCallEvent } from "../../../server/llm-logger.js";
import { createLogger } from "../../../logger.js";
import {
  extractDiscoveryCandidates,
  mergeCandidatesIntoDiscoveryResult,
  type DiscoverStepResult,
} from "./candidates.js";
import { parsePrimaryOrReasoning } from "./parse.js";
import { prepareDiscoveryStep } from "./context.js";

export type { DiscoverStepResult } from "./candidates.js";
export { backfillGlobalAvailabilityRules } from "./parse.js";

const logger = createLogger("discover");

export interface DiscoverStepConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  onRetry?: (attempt: number, maxRetries: number, reason: string) => void;
  skills?: Skill[];
  maxCharsPerSkill?: number;
  /** Retry config for transient LLM-call failures. Falls back to no-retry when omitted. */
  llmRetry?: LlmRetryConfig;
  /** Caller cancellation signal (e.g. WebSocket disconnect, supersede-on-new-discover). */
  abortSignal?: AbortSignal;
  /**
   * Per-attempt timeout for the discover agent's `generate()` call. Without
   * this, a silently-stalled LLM stream (mid-stream socket reset with no
   * error surface) hangs forever — the AI SDK has no built-in idle timeout
   * and `withLlmRetry` only catches thrown errors. With it, each attempt
   * aborts after `llmCallMs` and surfaces a TimeoutError the retry layer
   * classifies as transient.
   */
  llmCallMs?: number;
}

const MAX_RETRIES = 3;


const AGENT_NAME = "discover";
const attemptPhase = (n: number): string => `attempt-${n}`;
const recoveryPhase = (n: number): string => `attempt-${n}-recovery`;

export const discoverStepTestHooks = {
  extractDiscoveryCandidates,
  mergeCandidatesIntoDiscoveryResult,
};

export async function runDiscoverStep(config: DiscoverStepConfig): Promise<DiscoverStepResult> {
  throwIfAborted(config.abortSignal);

  const ctx = await prepareDiscoveryStep({
    model: config.model,
    providers: config.providers,
    excludeServices: config.discoveryConfig.excludeServices,
    maxIterations: config.discoveryConfig.maxIterations,
    maxToolResultChars: config.discoveryConfig.maxToolResultChars,
    skills: config.skills,
    maxCharsPerSkill: config.maxCharsPerSkill,
    onToolCall: config.onToolCall,
    onIteration: config.onIteration,
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    throwIfAborted(config.abortSignal);

    const discoverCallId = newCallId();
    const discoverStartMs = Date.now();
    const discoverToolCalls: ToolCallEvent[] = [];
    // Recovery prompt needs more per-result context than the 500-char
    // observability slice; allocate a separate, larger budget.
    const recoveryToolHistory: RecoveryToolEntry[] = [];

    const logAttempt = (phase: string, opts: {
      promptText: string;
      responseText?: string;
      inputTokens: number;
      outputTokens: number;
      toolCalls: ToolCallEvent[];
      startMs: number;
      error?: string;
    }) => {
      logLlmCall({
        callId: discoverCallId,
        agent: AGENT_NAME,
        phase,
        promptChars: opts.promptText.length,
        prompt: opts.promptText,
        responseChars: opts.responseText?.length ?? 0,
        response: opts.responseText,
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens,
        durationMs: Date.now() - opts.startMs,
        toolCalls: opts.toolCalls,
        error: opts.error,
      });
    };

    logLlmCallStart({
      callId: discoverCallId,
      agent: AGENT_NAME,
      phase: attemptPhase(attempt),
      promptChars: ctx.fullPromptChars,
      prompt: ctx.fullPrompt,
    });

    try {
      const result = await runWithHardTimeout(config.llmCallMs, (abortSignal) =>
        ctx.agent.generate(ctx.discoverPrompt, {
          abortSignal,
          providerOptions: {
            "openai-compatible": { max_tokens: config.discoveryConfig.maxOutputTokens },
          },
          onStepFinish: (step: { toolResults?: MastraToolResultLike[] }) => {
            if (!step.toolResults?.length) return;
            for (const tr of step.toolResults) {
              try {
                const { toolName, args, argsStr, resultStr } = extractMastraToolResult(tr);
                ctx.recordRawToolResult(toolName, args, resultStr);
                const toolEvent: ToolCallEvent = {
                  tool: toolName,
                  argsChars: argsStr.length,
                  args: argsStr.slice(0, 500),
                  resultChars: resultStr.length,
                  result: resultStr.slice(0, 500),
                };
                discoverToolCalls.push(toolEvent);
                logToolCall(discoverCallId, AGENT_NAME, toolEvent);
                recoveryToolHistory.push({
                  tool: toolName,
                  args: argsStr.slice(0, 500),
                  result: resultStr.slice(0, RECOVERY_TOOL_RESULT_CHARS),
                });
              } catch (err) {
                // Observability must never crash the discover step.
                logger.warn({ err }, "discover: onStepFinish failed to record tool call");
              }
            }
          },
        } as any),
        config.abortSignal,
      );

      const usage = getUsage(result);
      if (usage && config.onTokenUsage) config.onTokenUsage(usage);

      logAttempt(attemptPhase(attempt), {
        promptText: ctx.fullPrompt,
        responseText: result.text,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        toolCalls: discoverToolCalls,
        startMs: discoverStartMs,
      });

      const primary = parsePrimaryOrReasoning(result);
      if (primary) {
        return mergeCandidatesIntoDiscoveryResult(primary, ctx.discoveredCandidates, ctx.excludeServices);
      }

      const recovered = await runStallRecovery<DiscoverStepResult>({
        agent: ctx.agent,
        attempt,
        recoveryHistory: recoveryToolHistory,
        primaryResponseChars: result.text?.length ?? 0,
        maxOutputTokens: config.discoveryConfig.maxOutputTokens,
        abortSignal: config.abortSignal,
        callerAbortRacing: runWithHardTimeout,
        recoveryPhase,
        agentName: AGENT_NAME,
        onTokenUsage: config.onTokenUsage,
        llmRetry: config.llmRetry,
        onRetry: config.onRetry,
        parse: (r) => {
          const parsed = parsePrimaryOrReasoning(r);
          return parsed
            ? mergeCandidatesIntoDiscoveryResult(parsed, ctx.discoveredCandidates, ctx.excludeServices)
            : null;
        },
      });
      if (recovered) return recovered;

      const respLen = result.text?.length ?? 0;
      logger.warn(
        {
          attempt, maxRetries: MAX_RETRIES, responseChars: respLen,
          first200: result.text?.slice(0, 200) ?? "",
          last200: result.text?.slice(-200) ?? "",
        },
        `discovery: parse failed on ${respLen}-char response (attempt ${attempt}/${MAX_RETRIES})`,
      );
      config.onRetry?.(attempt, MAX_RETRIES, "parse failed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAttempt(attemptPhase(attempt), {
        promptText: ctx.fullPrompt,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: discoverToolCalls,
        startMs: discoverStartMs,
        error: message,
      });
      if (isLlmTimeoutError(err)) {
        if (ctx.discoveredCandidates.size > 0) {
          logger.warn(
            { attempt, candidateServiceCount: ctx.discoveredCandidates.size },
            "discovery: primary LLM timed out after tool data was captured — returning deterministic candidates instead of replaying discovery",
          );
          return ctx.returnCandidatesOnly();
        }
        logger.warn({ attempt, err: message }, "discovery: primary LLM timed out before usable tool data was captured — failing fast");
        throw err;
      }
      logger.warn({ attempt, err: message }, "discovery attempt failed");
      // LlmUnavailable bubbles out of the parse-retry loop — tool-less recovery
      // already exhausted its own retry budget upstream.
      if (err instanceof LlmUnavailableError) throw err;
      if (attempt === MAX_RETRIES) throw err;
      // Backoff with caller-cancellable sleep so disconnect aborts aren't
      // delayed by up to 30s of dead time.
      await sleepWithBackoff(attempt, config.abortSignal);
    }
  }

  logger.error({ maxRetries: MAX_RETRIES }, "discovery: agent returned no parseable services after all retries — returning empty list");
  if (ctx.discoveredCandidates.size > 0) {
    logger.warn({ candidateServiceCount: ctx.discoveredCandidates.size }, "discovery: returning deterministic candidates after all LLM parse attempts failed");
    return ctx.returnCandidatesOnly();
  }
  return { services: [], globalProbeRules: [] };
}

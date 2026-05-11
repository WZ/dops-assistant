/**
 * Stall recovery for the discover agent.
 *
 * gpt-oss-120b on saturated context sometimes stops calling tools and emits
 * either 0 chars or a syntactically valid but unusable empty payload (`[]`).
 * The `prepareStep` wind-down can't help when the model voluntarily exits at
 * step 6-9, well before maxSteps-2 fires the wind-down. This module invokes a
 * follow-up turn with the captured tool data inlined and `toolChoice: "none"`
 * so the model has only one job: synthesize JSON from the prior tool data.
 *
 * Lives in its own file because the recovery logic is gpt-oss-120b-specific
 * and would dwarf the primary discovery flow if left inline.
 */

import { withLlmRetry, safeAgentRetryConfig, type LlmRetryConfig } from "../../../agents/shared/llm-retry.js";
import { LlmUnavailableError } from "../../../agents/shared/llm-errors.js";
import { UNTRUSTED_DATA_NOTICE, wrapUntrusted } from "../../../agents/shared/prompt-helpers.js";
import { getUsage } from "../../../agents/shared/llm-result.js";
import { logLlmCall, logLlmCallStart, newCallId } from "../../../server/llm-logger.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("discover");

/**
 * Per-attempt timeout for the recovery `agent.generate` call. Recovery runs
 * with `toolChoice: "none"`, so a single forward pass is enough — 60s leaves
 * room for slow first-token times without inheriting the 120s exploration
 * budget.
 */
export const RECOVERY_TIMEOUT_MS = 60_000;

/**
 * Per-tool-result budget retained for recovery's follow-up prompt. Larger
 * than the 500-char observability slice (which only feeds logs and the UI
 * tool-call panel) because the recovery prompt needs enough context for the
 * model to actually synthesize JSON from the prior tool data.
 */
export const RECOVERY_TOOL_RESULT_CHARS = 4000;

const STALL_RECOVERY_PROMPT_HEADER =
  "You previously made the following tool calls during service discovery. " +
  "Based ONLY on this data, output the services list as JSON now. " +
  "Do NOT call more tools. " +
  "Use the exact JSON shape from your original instructions: " +
  '{"services": [...], "globalProbeRules": [...]}. ' +
  "Each service object must include name, metrics, logLabels, and probeRules. " +
  `${UNTRUSTED_DATA_NOTICE} ` +
  "Output JSON only — no prose, no markdown fences.";

export interface RecoveryToolEntry {
  tool: string;
  args: string;
  result: string;
}

function formatRecoveryToolHistory(history: RecoveryToolEntry[]): string {
  return history
    .map((entry, idx) => {
      return [
        `### Tool call ${idx + 1}: ${entry.tool}`,
        "Args:",
        wrapUntrusted("tool_args", entry.args),
        "Result:",
        wrapUntrusted("tool_result", entry.result),
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

export interface StallRecoveryDeps {
  /** The same Mastra agent the primary attempt used. */
  agent: { generate: (prompt: string, opts: any) => Promise<{ text?: string } & Record<string, unknown>> };
  attempt: number;
  recoveryHistory: RecoveryToolEntry[];
  primaryResponseChars: number;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
  callerAbortRacing: <T>(timeoutMs: number | undefined, work: (sig?: AbortSignal) => Promise<T>, parent?: AbortSignal) => Promise<T>;
  recoveryPhase: (n: number) => string;
  agentName: string;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  llmRetry?: LlmRetryConfig;
  onRetry?: (attempt: number, maxRetries: number, reason: string) => void;
  /** Caller-supplied parser — returns recovered result or `null`. Same contract as `parsePrimaryOrReasoning` in discover.ts. */
  parse: (result: unknown) => unknown | null;
}

/**
 * Run a stall-recovery follow-up. Returns the parsed result on success, or
 * `null` when recovery either had nothing to do, returned unparseable output,
 * or transiently failed. Throws on `LlmUnavailableError` so the surrounding
 * retry loop can short-circuit.
 */
export async function runStallRecovery<T>(deps: StallRecoveryDeps): Promise<T | null> {
  if (deps.recoveryHistory.length === 0) return null;

  const recoveryCallId = newCallId();
  const recoveryStartMs = Date.now();
  const historyBlock = formatRecoveryToolHistory(deps.recoveryHistory);
  const recoveryPrompt = `${STALL_RECOVERY_PROMPT_HEADER}\n\n${historyBlock}`;
  const phase = deps.recoveryPhase(deps.attempt);

  logger.warn(
    {
      attempt: deps.attempt,
      toolCallCount: deps.recoveryHistory.length,
      responseChars: deps.primaryResponseChars,
      recoveryCallId,
    },
    "discovery: unusable synthesis after tool-using session — invoking stall-recovery",
  );
  logLlmCallStart({
    callId: recoveryCallId,
    agent: deps.agentName,
    phase,
    promptChars: recoveryPrompt.length,
    prompt: recoveryPrompt,
  });

  const logRecovery = (opts: {
    responseText?: string;
    inputTokens: number;
    outputTokens: number;
    error?: string;
  }) => logLlmCall({
    callId: recoveryCallId,
    agent: deps.agentName,
    phase,
    promptChars: recoveryPrompt.length,
    prompt: recoveryPrompt,
    responseChars: opts.responseText?.length ?? 0,
    response: opts.responseText,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    durationMs: Date.now() - recoveryStartMs,
    toolCalls: [],
    error: opts.error,
  });

  const baseRetryConfig = safeAgentRetryConfig(deps.llmRetry, true);
  const retryConfig: LlmRetryConfig = deps.onRetry
    ? { ...baseRetryConfig, onRetry: deps.onRetry }
    : baseRetryConfig;

  try {
    const recoveryResult = await withLlmRetry(
      () => deps.callerAbortRacing(RECOVERY_TIMEOUT_MS, (abortSignal) =>
        deps.agent.generate(recoveryPrompt, {
          abortSignal,
          providerOptions: {
            "openai-compatible": { max_tokens: deps.maxOutputTokens, reasoning_effort: "low" },
          },
          toolChoice: "none",
        }), deps.abortSignal),
      retryConfig,
    );

    const recoveryUsage = getUsage(recoveryResult);
    if (recoveryUsage && deps.onTokenUsage) deps.onTokenUsage(recoveryUsage);
    logRecovery({
      responseText: recoveryResult.text,
      inputTokens: recoveryUsage?.inputTokens ?? 0,
      outputTokens: recoveryUsage?.outputTokens ?? 0,
    });

    const recovered = deps.parse(recoveryResult) as T | null;
    if (recovered) {
      logger.info({ attempt: deps.attempt }, "discovery: stall-recovery succeeded");
      return recovered;
    }
    logger.warn(
      { attempt: deps.attempt, recoveryResponseChars: recoveryResult.text?.length ?? 0 },
      "discovery: stall-recovery returned unparseable output",
    );
    return null;
  } catch (err) {
    const recoveryMessage = err instanceof Error ? err.message : String(err);
    logRecovery({ inputTokens: 0, outputTokens: 0, error: recoveryMessage });
    logger.warn({ attempt: deps.attempt, err: recoveryMessage }, "discovery: stall-recovery threw");
    if (err instanceof LlmUnavailableError) throw err;
    return null;
  }
}

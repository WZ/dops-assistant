/**
 * Centralized LLM observability logger.
 *
 * Controlled by LLM_LOG_LEVEL env var:
 *   - not set / "silent": no LLM logging (zero overhead)
 *   - "info": log summaries (agent, tokens, duration, tool count)
 *   - "debug": log full prompts, responses, and tool call details
 */

import { createLogger } from "../logger.js";
import { randomUUID } from "node:crypto";

const level = process.env["LLM_LOG_LEVEL"] ?? "silent";

export const llmLogger = createLogger("llm", { level });

// ── Types ───────────────────────────────────────────────────────────────────

export interface ToolCallEvent {
  tool: string;
  argsChars: number;
  args?: string;
  resultChars: number;
  result?: string;
  durationMs?: number;
  error?: string;
}

export interface LlmCallEvent {
  callId: string;
  agent: string;
  phase?: string;
  promptChars: number;
  prompt?: string;
  responseChars: number;
  response?: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  toolCalls: ToolCallEvent[];
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a short unique ID for correlating LLM call events. */
export function newCallId(): string {
  return randomUUID().slice(0, 8);
}

// ── Logging functions ───────────────────────────────────────────────────────

/** Log a complete LLM call (info: summary, debug: full content). */
export function logLlmCall(event: LlmCallEvent): void {
  if (!llmLogger.isLevelEnabled("info")) return;

  llmLogger.info({
    callId: event.callId,
    agent: event.agent,
    phase: event.phase,
    promptChars: event.promptChars,
    responseChars: event.responseChars,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    durationMs: event.durationMs,
    toolCallCount: event.toolCalls.length,
    error: event.error,
  }, `LLM ${event.agent}: ${event.inputTokens}in/${event.outputTokens}out ${event.durationMs}ms`);

  if (llmLogger.isLevelEnabled("debug")) {
    llmLogger.debug({
      callId: event.callId,
      prompt: event.prompt,
      response: event.response,
      toolCalls: event.toolCalls,
    }, `LLM ${event.agent} details`);
  }
}

/** Log an individual tool call within an LLM conversation. */
export function logToolCall(callId: string, agent: string, event: ToolCallEvent): void {
  if (!llmLogger.isLevelEnabled("debug")) return;

  llmLogger.debug({
    callId,
    agent,
    tool: event.tool,
    argsChars: event.argsChars,
    resultChars: event.resultChars,
    durationMs: event.durationMs,
    error: event.error,
    args: event.args,
    result: event.result,
  }, `Tool ${event.tool}: ${event.resultChars}chars ${event.durationMs ?? 0}ms`);
}

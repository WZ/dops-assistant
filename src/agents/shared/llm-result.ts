/**
 * AI-SDK / Mastra agent result shape varies between models and SDK versions:
 *   - usage may appear as `totalUsage` (newer) or `usage` (older)
 *   - reasoning may appear as `reasoningText` (AI SDK) or `reasoning` (Mastra)
 * These helpers hide the shape so callers don't sprinkle `(result as any)` casts.
 */

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface AgentResultLike {
  text?: string;
  totalUsage?: { inputTokens?: number; outputTokens?: number };
  usage?: { inputTokens?: number; outputTokens?: number };
  reasoningText?: string;
  reasoning?: string;
}

export function getUsage(result: unknown): AgentTokenUsage | undefined {
  const r = result as AgentResultLike;
  const raw = r?.totalUsage ?? r?.usage;
  if (!raw) return undefined;
  return {
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
  };
}

export function getReasoningText(result: unknown): string | undefined {
  const r = result as AgentResultLike;
  const t = r?.reasoningText ?? r?.reasoning;
  return typeof t === "string" ? t : undefined;
}

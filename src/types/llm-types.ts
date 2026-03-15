/**
 * Shared LLM types used across the codebase.
 * Extracted from the legacy src/llm/openai.ts to decouple consumers
 * from the OpenAI-specific implementation.
 */

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[];
  name?: string;
};

export type TokenUsage = { inputTokens: number; outputTokens: number };

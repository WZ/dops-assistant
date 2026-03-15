import type { IChatAgent } from "../../types/agent-interfaces.js";
import type { ChatOutput, TokenSummary } from "../types.js";
import { createToolCollector } from "../tool-collector.js";

export type ChatOptions = {
  verbose: boolean;
};

// Note: ChatRequest.onToolCall has a 3-param signature (name, args, result)
// while OnToolCallEnriched has 6 params. The collector.callback will work
// (extra params are assignable) but durationMs/error/phase will always be
// undefined for chat tool calls. This is a known limitation — the chat agent
// stream does not provide per-tool timing data.

export async function runChat(
  agent: IChatAgent,
  message: string,
  opts: ChatOptions,
): Promise<ChatOutput> {
  const start = performance.now();
  const collector = createToolCollector(opts.verbose);
  let tokens: TokenSummary | null = null;

  try {
    const response = await agent.chat({
      mode: "conversational",
      message,
      history: [],
      onToolCall: collector.callback,
      onTokenUsage: (usage) => {
        if (!tokens) tokens = { input: 0, output: 0, total: 0 };
        tokens.input += usage.inputTokens;
        tokens.output += usage.outputTokens;
        tokens.total += usage.inputTokens + usage.outputTokens;
      },
    });

    return {
      command: "chat",
      message,
      status: "success",
      durationMs: Math.round(performance.now() - start),
      tokens,
      toolCalls: collector.getRecords(),
      result: { response: response.response },
      error: null,
    };
  } catch (err) {
    return {
      command: "chat",
      message,
      status: "error",
      durationMs: Math.round(performance.now() - start),
      tokens,
      toolCalls: collector.getRecords(),
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

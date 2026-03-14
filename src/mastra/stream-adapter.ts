// src/mastra/stream-adapter.ts

interface ChatStreamCallbacks {
  onStreamStart?: () => void;
  onStreamDelta?: (delta: { type: "reasoning" | "content"; content: string }) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, result?: string) => void;
  onTokenUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}

interface InvestigationCallbacks {
  onPhase?: (label: string) => void;
  onIteration?: (phase: string, step: number, total: number) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, result?: string) => void;
}

export async function adaptChatStream(
  stream: { textStream: AsyncIterable<string>; text: Promise<string> },
  callbacks: ChatStreamCallbacks,
): Promise<string> {
  let started = false;
  for await (const chunk of stream.textStream) {
    if (!started) {
      callbacks.onStreamStart?.();
      started = true;
    }
    callbacks.onStreamDelta?.({ type: "content", content: chunk });
  }
  return stream.text;
}

export function createInvestigationEmitter(callbacks: InvestigationCallbacks) {
  return {
    emitPhase(label: string) { callbacks.onPhase?.(label); },
    emitIteration(phase: string, step: number, total: number) { callbacks.onIteration?.(phase, step, total); },
    emitToolCall(name: string, args: Record<string, unknown>, result?: string) { callbacks.onToolCall?.(name, args, result); },
  };
}

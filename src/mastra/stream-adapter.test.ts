import { describe, it, expect, vi } from "vitest";
import { adaptChatStream, createInvestigationEmitter } from "./stream-adapter.js";

// Helper to build a fake stream from an array of string chunks
function fakeStream(chunks: string[]): {
  textStream: AsyncIterable<string>;
  text: Promise<string>;
} {
  async function* gen() {
    for (const chunk of chunks) {
      yield chunk;
    }
  }
  const text = Promise.resolve(chunks.join(""));
  return { textStream: gen(), text };
}

describe("adaptChatStream", () => {
  it("maps text chunks to onStreamDelta with type 'content'", async () => {
    const deltas: Array<{ type: string; content: string }> = [];
    const stream = fakeStream(["Hello", ", ", "world"]);

    await adaptChatStream(stream, {
      onStreamDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toHaveLength(3);
    expect(deltas[0]).toEqual({ type: "content", content: "Hello" });
    expect(deltas[1]).toEqual({ type: "content", content: ", " });
    expect(deltas[2]).toEqual({ type: "content", content: "world" });
  });

  it("calls onStreamStart on the first chunk only", async () => {
    const onStreamStart = vi.fn();
    const stream = fakeStream(["chunk1", "chunk2", "chunk3"]);

    await adaptChatStream(stream, { onStreamStart });

    expect(onStreamStart).toHaveBeenCalledTimes(1);
  });

  it("does not call onStreamStart when stream is empty", async () => {
    const onStreamStart = vi.fn();
    const stream = fakeStream([]);

    await adaptChatStream(stream, { onStreamStart });

    expect(onStreamStart).not.toHaveBeenCalled();
  });

  it("returns the full concatenated text from stream.text", async () => {
    const stream = fakeStream(["foo", "bar", "baz"]);

    const result = await adaptChatStream(stream, {});

    expect(result).toBe("foobarbaz");
  });

  it("works without any callbacks provided", async () => {
    const stream = fakeStream(["hello"]);
    await expect(adaptChatStream(stream, {})).resolves.toBe("hello");
  });

  it("does not call onStreamDelta when stream is empty", async () => {
    const onStreamDelta = vi.fn();
    const stream = fakeStream([]);

    await adaptChatStream(stream, { onStreamDelta });

    expect(onStreamDelta).not.toHaveBeenCalled();
  });
});

describe("createInvestigationEmitter", () => {
  it("emits phase events via onPhase callback", () => {
    const onPhase = vi.fn();
    const emitter = createInvestigationEmitter({ onPhase });

    emitter.emitPhase("evidence-gathering");

    expect(onPhase).toHaveBeenCalledOnce();
    expect(onPhase).toHaveBeenCalledWith("evidence-gathering");
  });

  it("emits iteration events via onIteration callback", () => {
    const onIteration = vi.fn();
    const emitter = createInvestigationEmitter({ onIteration });

    emitter.emitIteration("synthesis", 3, 10);

    expect(onIteration).toHaveBeenCalledOnce();
    expect(onIteration).toHaveBeenCalledWith("synthesis", 3, 10);
  });

  it("emits tool call events via onToolCall callback", () => {
    const onToolCall = vi.fn();
    const emitter = createInvestigationEmitter({ onToolCall });

    emitter.emitToolCall("list_datasources", { limit: 10 }, '{"datasources": []}');

    expect(onToolCall).toHaveBeenCalledOnce();
    expect(onToolCall).toHaveBeenCalledWith("list_datasources", { limit: 10 }, '{"datasources": []}');
  });

  it("emits tool call without result argument", () => {
    const onToolCall = vi.fn();
    const emitter = createInvestigationEmitter({ onToolCall });

    emitter.emitToolCall("query_metrics", { query: "up" });

    expect(onToolCall).toHaveBeenCalledWith("query_metrics", { query: "up" }, undefined);
  });

  it("does not throw when callbacks are not provided", () => {
    const emitter = createInvestigationEmitter({});

    expect(() => emitter.emitPhase("test")).not.toThrow();
    expect(() => emitter.emitIteration("test", 1, 5)).not.toThrow();
    expect(() => emitter.emitToolCall("test", {})).not.toThrow();
  });

  it("emits multiple phases in order", () => {
    const phases: string[] = [];
    const emitter = createInvestigationEmitter({ onPhase: (label) => phases.push(label) });

    emitter.emitPhase("prefetch");
    emitter.emitPhase("evidence");
    emitter.emitPhase("synthesis");

    expect(phases).toEqual(["prefetch", "evidence", "synthesis"]);
  });
});

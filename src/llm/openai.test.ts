import { describe, it, expect, vi, beforeEach } from "vitest";
import { LlmClient, convertToResponsesInput } from "./openai.js";
import type { LlmConfig, Message } from "./openai.js";
import { TimeoutError } from "../utils/timeout.js";
import type { TimeoutsConfig, RetryConfig } from "../config/schema.js";

vi.mock("openai", () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        responses: {
          create: mockCreate,
        },
      };
    }),
    __mockCreate: mockCreate,
  };
});

const config: LlmConfig = {
  apiKey: "test-key",
  model: "gpt-4",
  maxTokens: 4096,
};

const defaultTimeouts: TimeoutsConfig = {
  mcpConnectMs: 30_000,
  llmCallMs: 60_000,
  toolExecutionMs: 30_000,
  agentIterationMs: 90_000,
};

const defaultRetry: RetryConfig = { maxAttempts: 1, baseDelayMs: 0 };

async function getMockCreate() {
  const mod = await import("openai");
  return (mod as unknown as { __mockCreate: ReturnType<typeof vi.fn> }).__mockCreate;
}

describe("LlmClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns text response when no tool calls", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Everything looks healthy." }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const result = await client.chat([{ role: "user", content: "Check the system." }], []);
    expect(result).toEqual({ type: "text", content: "Everything looks healthy.", usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it("returns tool_calls response when LLM requests tools", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "query_prometheus",
          arguments: '{"query":"up"}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const tools = [{ function: { name: "query_prometheus", description: "Query Prometheus", parameters: {} } }];
    const result = await client.chat([{ role: "user", content: "Check metrics." }], tools);
    expect(result).toEqual({
      type: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5 },
      calls: [
        {
          id: "call_1",
          name: "query_prometheus",
          args: { query: "up" },
        },
      ],
    });
  });

  it("passes baseURL to OpenAI client when configured", async () => {
    const OpenAI = (await import("openai")).default;
    new LlmClient({ ...config, baseURL: "https://custom.endpoint/v1" }, defaultTimeouts, defaultRetry);
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://custom.endpoint/v1" })
    );
  });

  it("throws when output array is empty", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({ output: [], usage: null });

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    await expect(
      client.chat([{ role: "user", content: "Hello" }], [])
    ).rejects.toThrow("LLM returned no output (possible content filter or API error)");
  });

  it("retries when hallucinated function calls produce empty content (no tools provided)", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce({
      output: [
        { type: "function_call", call_id: "fake_1", name: "<|constrain|>json", arguments: "{}" },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    mockCreate.mockResolvedValueOnce({
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"result": "ok"}' }] },
      ],
      usage: { input_tokens: 110, output_tokens: 60 },
    });

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const result = await client.chat([{ role: "user", content: "Produce JSON." }], []);
    expect(result.type).toBe("text");
    expect(result.content).toBe('{"result": "ok"}');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("returns empty content after max hallucination retries exhausted", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      output: [
        { type: "function_call", call_id: "fake_1", name: "<|constrain|>json", arguments: "{}" },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const result = await client.chat([{ role: "user", content: "Produce JSON." }], []);
    expect(result.type).toBe("text");
    expect(result.content).toBe("");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("does not retry hallucinated calls when tools are provided", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      output: [
        { type: "function_call", call_id: "call_1", name: "query_prometheus", arguments: '{"query":"up"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const tools = [{ function: { name: "query_prometheus", description: "Query", parameters: {} } }];
    const result = await client.chat([{ role: "user", content: "Check." }], tools);
    expect(result.type).toBe("tool_calls");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("throws when tool arguments contain malformed JSON", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      output: [
        {
          type: "function_call",
          call_id: "call_bad",
          name: "broken_tool",
          arguments: "not-valid-json{",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const tools = [{ function: { name: "broken_tool", description: "A tool", parameters: {} } }];
    await expect(
      client.chat([{ role: "user", content: "Run tool." }], tools)
    ).rejects.toThrow('Failed to parse tool arguments for "broken_tool": not-valid-json{');
  });
});

describe("LlmClient – timeout and retry", () => {
  it("wraps chat call with timeout", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockImplementation(() => new Promise(() => {})); // hangs forever

    const timeouts: TimeoutsConfig = {
      mcpConnectMs: 30_000,
      llmCallMs: 1,
      toolExecutionMs: 30_000,
      agentIterationMs: 90_000,
    };
    const retry: RetryConfig = { maxAttempts: 1, baseDelayMs: 0 };

    const client = new LlmClient(config, timeouts, retry);
    await expect(client.chat([], [])).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("LlmClient – chatStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("yields reasoning and content deltas then done for text response", async () => {
    const mockCreate = await getMockCreate();

    async function* fakeStream() {
      yield { type: "response.created", response: { id: "r1", status: "in_progress", usage: null } };
      yield { type: "response.reasoning_text.delta", delta: "Let me", output_index: 0, content_index: 0 };
      yield { type: "response.reasoning_text.delta", delta: " think", output_index: 0, content_index: 0 };
      yield { type: "response.output_text.delta", delta: "Hello", output_index: 1, content_index: 0 };
      yield { type: "response.output_text.delta", delta: " world", output_index: 1, content_index: 0 };
      yield {
        type: "response.completed",
        response: {
          id: "r1", status: "completed",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
    }

    mockCreate.mockReturnValue(fakeStream());

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const events: unknown[] = [];
    for await (const event of client.chatStream([{ role: "user", content: "Hi" }], [])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "reasoning", content: "Let me" },
      { type: "reasoning", content: " think" },
      { type: "content", content: "Hello" },
      { type: "content", content: " world" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it("yields tool_calls then done when LLM requests tools", async () => {
    const mockCreate = await getMockCreate();

    async function* fakeStream() {
      yield { type: "response.output_item.added", item: { type: "function_call", id: "item_abc", call_id: "call_1", name: "query_prometheus" }, output_index: 0 };
      yield { type: "response.function_call_arguments.delta", item_id: "item_abc", delta: '{"quer', output_index: 0 };
      yield { type: "response.function_call_arguments.delta", item_id: "item_abc", delta: 'y":"up"}', output_index: 0 };
      yield { type: "response.function_call_arguments.done", item_id: "item_abc", arguments: '{"query":"up"}', output_index: 0 };
      yield {
        type: "response.completed",
        response: { id: "r1", status: "completed", usage: { input_tokens: 20, output_tokens: 10 } },
      };
    }

    mockCreate.mockReturnValue(fakeStream());

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const tools = [{ function: { name: "query_prometheus", description: "Query", parameters: {} } }];
    const events: unknown[] = [];
    for await (const event of client.chatStream([{ role: "user", content: "Check" }], tools)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "tool_calls", calls: [{ id: "call_1", name: "query_prometheus", args: { query: "up" } }] },
      { type: "done", usage: { inputTokens: 20, outputTokens: 10 } },
    ]);
  });

  it("ignores hallucinated tool calls when no tools provided in stream", async () => {
    const mockCreate = await getMockCreate();

    async function* fakeStream() {
      yield { type: "response.output_item.added", item: { type: "function_call", id: "item_fake", call_id: "fake_1", name: "hallucinated" }, output_index: 0 };
      yield { type: "response.function_call_arguments.done", item_id: "item_fake", arguments: '{}', output_index: 0 };
      yield {
        type: "response.completed",
        response: { id: "r1", status: "completed", usage: { input_tokens: 5, output_tokens: 3 } },
      };
    }

    mockCreate.mockReturnValue(fakeStream());

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const events: unknown[] = [];
    for await (const event of client.chatStream([{ role: "user", content: "Hi" }], [])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "done", usage: { inputTokens: 5, outputTokens: 3 } },
    ]);
  });

  it("yields done with usage on response.incomplete", async () => {
    const mockCreate = await getMockCreate();

    async function* fakeStream() {
      yield { type: "response.output_text.delta", delta: "Partial", output_index: 0, content_index: 0 };
      yield {
        type: "response.incomplete",
        response: { id: "r1", status: "incomplete", usage: { input_tokens: 10, output_tokens: 100 } },
      };
    }

    mockCreate.mockReturnValue(fakeStream());

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const events: unknown[] = [];
    for await (const event of client.chatStream([{ role: "user", content: "Hi" }], [])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "content", content: "Partial" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 100 } },
    ]);
  });

  it("throws TimeoutError on idle timeout", async () => {
    const mockCreate = await getMockCreate();

    async function* fakeStream() {
      yield { type: "response.output_text.delta", delta: "Hello", output_index: 0, content_index: 0 };
      // Second next() hangs forever
      await new Promise(() => {});
    }

    mockCreate.mockReturnValue(fakeStream());

    const shortTimeouts: TimeoutsConfig = {
      mcpConnectMs: 30_000,
      llmCallMs: 50,
      toolExecutionMs: 30_000,
      agentIterationMs: 90_000,
    };
    const client = new LlmClient(config, shortTimeouts, defaultRetry);
    const events: unknown[] = [];
    await expect(async () => {
      for await (const event of client.chatStream([{ role: "user", content: "Hi" }], [])) {
        events.push(event);
      }
    }).rejects.toThrow("LLM stream");

    expect(events).toEqual([{ type: "content", content: "Hello" }]);
  });

  it("throws when responses.create() fails during initialization", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockRejectedValue(new Error("API key invalid"));

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    await expect(async () => {
      for await (const _event of client.chatStream([{ role: "user", content: "Hi" }], [])) {
        // should not reach here
      }
    }).rejects.toThrow("API key invalid");
  });

  it("throws on response.failed", async () => {
    const mockCreate = await getMockCreate();

    async function* fakeStream() {
      yield { type: "response.output_text.delta", delta: "Start", output_index: 0, content_index: 0 };
      yield { type: "response.failed", response: { id: "r1", status: "failed" } };
    }

    mockCreate.mockReturnValue(fakeStream());

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const events: unknown[] = [];
    await expect(async () => {
      for await (const event of client.chatStream([{ role: "user", content: "Hi" }], [])) {
        events.push(event);
      }
    }).rejects.toThrow("LLM streaming response failed");

    expect(events).toEqual([{ type: "content", content: "Start" }]);
  });
});

describe("convertToResponsesInput", () => {
  it("extracts system messages as instructions", () => {
    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const { instructions, input } = convertToResponsesInput(messages);
    expect(instructions).toBe("You are helpful.");
    expect(input).toHaveLength(1);
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: "Hello",
    });
  });

  it("converts assistant tool_calls to function_call items", () => {
    const messages: Message[] = [
      { role: "assistant", content: null, tool_calls: [
        { id: "c1", name: "foo", args: { bar: 1 } },
      ]},
    ];
    const { input } = convertToResponsesInput(messages);
    expect(input).toEqual([
      { type: "function_call", call_id: "c1", name: "foo", arguments: '{"bar":1}' },
    ]);
  });

  it("converts tool messages to function_call_output items", () => {
    const messages: Message[] = [
      { role: "tool", content: "result", tool_call_id: "c1" },
    ];
    const { input } = convertToResponsesInput(messages);
    expect(input).toEqual([
      { type: "function_call_output", call_id: "c1", output: "result" },
    ]);
  });
});

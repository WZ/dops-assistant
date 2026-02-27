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
    expect(result).toEqual({ type: "text", content: "Everything looks healthy." });
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
    const result = await client.chat([{ role: "user", content: "Check metrics." }], []);
    expect(result).toEqual({
      type: "tool_calls",
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
    await expect(
      client.chat([{ role: "user", content: "Run tool." }], [])
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

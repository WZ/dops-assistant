import { describe, it, expect, vi, beforeEach } from "vitest";
import { LlmClient } from "./openai.js";
import type { LlmConfig } from "./openai.js";
import { TimeoutError } from "../utils/timeout.js";
import type { TimeoutsConfig, RetryConfig } from "../config/schema.js";

vi.mock("openai", () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        chat: {
          completions: {
            create: mockCreate,
          },
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
      choices: [
        {
          message: {
            role: "assistant",
            content: "Everything looks healthy.",
            tool_calls: null,
          },
          finish_reason: "stop",
        },
      ],
    });

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    const result = await client.chat([{ role: "user", content: "Check the system." }], []);
    expect(result).toEqual({ type: "text", content: "Everything looks healthy." });
  });

  it("returns tool_calls response when LLM requests tools", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "query_prometheus", arguments: '{"query":"up"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
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

  it("throws when choices array is empty (possible content filter)", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({ choices: [] });

    const client = new LlmClient(config, defaultTimeouts, defaultRetry);
    await expect(
      client.chat([{ role: "user", content: "Hello" }], [])
    ).rejects.toThrow("LLM returned no choices (possible content filter or API error)");
  });

  it("throws when tool arguments contain malformed JSON", async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: { name: "broken_tool", arguments: "not-valid-json{" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
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

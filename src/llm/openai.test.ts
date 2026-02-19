import { describe, it, expect, vi, beforeEach } from "vitest";
import { LlmClient } from "./openai.js";
import type { LlmConfig } from "./openai.js";

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

    const client = new LlmClient(config);
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

    const client = new LlmClient(config);
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
    new LlmClient({ ...config, baseURL: "https://custom.endpoint/v1" });
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://custom.endpoint/v1" })
    );
  });
});

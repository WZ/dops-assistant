import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCore } from "./core.js";
import type { McpClient } from "../mcp/client.js";
import type { LlmClient } from "../llm/openai.js";

const mockLlm = {
  chat: vi.fn(),
} as unknown as LlmClient;

const mockMcp = {
  getTools: vi.fn().mockReturnValue([
    {
      type: "function",
      function: { name: "query_prometheus", description: "Query metrics", parameters: {} },
    },
  ]),
  callTool: vi.fn(),
} as unknown as McpClient;

describe("AgentCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns text response directly when LLM produces no tool calls", async () => {
    (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "text",
      content: "All systems healthy.",
    });

    const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
    const result = await core.run({ mode: "proactive", message: "Check services." });

    expect(result.response).toBe("All systems healthy.");
    expect(mockLlm.chat).toHaveBeenCalledTimes(1);
  });

  it("executes tool calls and feeds results back to LLM", async () => {
    (mockLlm.chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: "tool_calls",
        calls: [{ id: "call_1", name: "query_prometheus", args: { query: "up" } }],
      })
      .mockResolvedValueOnce({ type: "text", content: "Metrics look fine." });

    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValue("1.0");

    const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
    const result = await core.run({ mode: "proactive", message: "Check metrics." });

    expect(result.response).toBe("Metrics look fine.");
    expect(mockLlm.chat).toHaveBeenCalledTimes(2);
    expect(mockMcp.callTool).toHaveBeenCalledWith("query_prometheus", { query: "up" });
  });

  it("returns truncation message when maxIterations reached", async () => {
    (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "tool_calls",
      calls: [{ id: "call_1", name: "query_prometheus", args: {} }],
    });
    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValue("data");

    const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 3 });
    const result = await core.run({ mode: "proactive", message: "Check." });

    expect(result.response).toContain("maximum iterations");
  });

  it("includes conversation history in messages", async () => {
    (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "text",
      content: "Response.",
    });

    const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
    const history = [
      { role: "user" as const, content: "Earlier message." },
      { role: "assistant" as const, content: "Earlier response." },
    ];
    await core.run({ mode: "conversational", message: "Follow up.", history });

    const callMessages = (mockLlm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Earlier message." }),
        expect.objectContaining({ content: "Earlier response." }),
      ])
    );
  });

  it("returns updatedHistory including new exchange", async () => {
    (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "text",
      content: "Done.",
    });

    const core = new AgentCore(mockLlm, mockMcp, { maxIterations: 10 });
    const result = await core.run({ mode: "conversational", message: "Hello." });

    const userMsg = result.updatedHistory.find((m) => m.role === "user" && m.content === "Hello.");
    const assistantMsg = result.updatedHistory.find((m) => m.role === "assistant" && m.content === "Done.");
    expect(userMsg).toBeDefined();
    expect(assistantMsg).toBeDefined();
  });
});

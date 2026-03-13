import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatAgent } from "./core.js";
import type { MultiMcpClient } from "../mcp/multi-client.js";
import type { LlmClient } from "../llm/openai.js";
import type { LlmStreamEvent } from "../llm/openai.js";

/** Convert old-style chat responses to streaming events */
function createMockLlm() {
  const responses: Array<
    | { type: "text"; content: string; usage?: { inputTokens: number; outputTokens: number } }
    | { type: "tool_calls"; calls: { id: string; name: string; args: Record<string, unknown> }[]; usage?: { inputTokens: number; outputTokens: number } }
  > = [];
  let callIndex = 0;

  const llm = {
    chatStream: vi.fn(async function* (): AsyncGenerator<LlmStreamEvent> {
      const resp = responses[callIndex++];
      if (!resp) return;

      if (resp.type === "text") {
        yield { type: "content", content: resp.content };
      } else if (resp.type === "tool_calls") {
        yield { type: "tool_calls", calls: resp.calls };
      }
      yield { type: "done", usage: resp.usage };
    }),
    chat: vi.fn(), // kept for investigation pipeline
  };

  return {
    llm: llm as unknown as LlmClient,
    mockResponse(resp: typeof responses[number]) {
      responses.push(resp);
    },
    reset() {
      callIndex = 0;
      responses.length = 0;
      vi.clearAllMocks();
    },
  };
}

/** Fine-grained mock for streaming callback tests */
function makeMockLlm(events: LlmStreamEvent[][]) {
  let callIndex = 0;
  return {
    chatStream: vi.fn(async function* () {
      const batch = events[callIndex++] ?? [];
      for (const e of batch) yield e;
    }),
    chat: vi.fn(),
  };
}

const mock = createMockLlm();

const mockMcp = {
  getTools: vi.fn().mockReturnValue([
    {
      type: "function",
      function: { name: "query_prometheus", description: "Query metrics", parameters: {} },
    },
  ]),
  callTool: vi.fn(),
  getProvidersByRole: vi.fn().mockReturnValue([]),
  getToolsByRole: vi.fn().mockReturnValue([]),
  hasRole: vi.fn().mockReturnValue(false),
} as unknown as MultiMcpClient;

describe("ChatAgent", () => {
  beforeEach(() => {
    mock.reset();
    vi.mocked(mockMcp.getTools).mockReturnValue([
      {
        type: "function",
        function: { name: "query_prometheus", description: "Query metrics", parameters: {} },
      },
    ]);
    vi.mocked(mockMcp.callTool).mockReset();
    vi.mocked(mockMcp.getProvidersByRole).mockReturnValue([]);
    vi.mocked(mockMcp.getToolsByRole).mockReturnValue([]);
    vi.mocked(mockMcp.hasRole).mockReturnValue(false);
  });

  it("returns text response directly when LLM produces no tool calls", async () => {
    mock.mockResponse({ type: "text", content: "All systems healthy." });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({ mode: "proactive", message: "Check services." });

    expect(result.response).toBe("All systems healthy.");
    expect((mock.llm as any).chatStream).toHaveBeenCalledTimes(1);
  });

  it("executes tool calls and feeds results back to LLM", async () => {
    mock.mockResponse({
      type: "tool_calls",
      calls: [{ id: "call_1", name: "query_prometheus", args: { query: "up" } }],
    });
    mock.mockResponse({ type: "text", content: "Metrics look fine." });

    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "1.0", images: [] });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({ mode: "proactive", message: "Check metrics." });

    expect(result.response).toBe("Metrics look fine.");
    expect((mock.llm as any).chatStream).toHaveBeenCalledTimes(2);
    expect(mockMcp.callTool).toHaveBeenCalledWith("query_prometheus", { query: "up" });
  });

  it("returns truncation message when maxIterations reached", async () => {
    mock.mockResponse({
      type: "tool_calls",
      calls: [{ id: "call_1", name: "query_prometheus", args: {} }],
    });
    mock.mockResponse({
      type: "tool_calls",
      calls: [{ id: "call_2", name: "query_prometheus", args: {} }],
    });
    mock.mockResponse({
      type: "tool_calls",
      calls: [{ id: "call_3", name: "query_prometheus", args: {} }],
    });
    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "data", images: [] });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 3 });
    const result = await core.chat({ mode: "proactive", message: "Check." });

    expect(result.response).toContain("maximum iterations");
  });

  it("includes conversation history in messages", async () => {
    mock.mockResponse({ type: "text", content: "Response." });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const history = [
      { role: "user" as const, content: "Earlier message." },
      { role: "assistant" as const, content: "Earlier response." },
    ];
    await core.chat({ mode: "conversational", message: "Follow up.", history });

    const callMessages = (mock.llm as any).chatStream.mock.calls[0][0];
    expect(callMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Earlier message." }),
        expect.objectContaining({ content: "Earlier response." }),
      ])
    );
  });

  it("handles transport-level MCP error without throwing and feeds error back to LLM", async () => {
    mock.mockResponse({
      type: "tool_calls",
      calls: [{ id: "call_1", name: "query_prometheus", args: { query: "up" } }],
    });
    mock.mockResponse({ type: "text", content: "Partial response despite error." });

    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("MCP process crashed")
    );

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({ mode: "proactive", message: "Check metrics." });

    // Agent must not throw — it should return a response
    expect(result.response).toBe("Partial response despite error.");

    // The second LLM call must have received a [Transport Error] tool message
    const secondCallMessages = (mock.llm as any).chatStream.mock.calls[1][0];
    const transportErrMsg = secondCallMessages.find(
      (m: { role: string; content: string }) =>
        m.role === "tool" && m.content.startsWith("[Transport Error]")
    );
    expect(transportErrMsg).toBeDefined();
    expect(transportErrMsg.content).toContain("MCP process crashed");
  });

  it("when one of two parallel tool calls fails, the successful result is still present in messages sent to LLM", async () => {
    mock.mockResponse({
      type: "tool_calls",
      calls: [
        { id: "call_ok", name: "query_prometheus", args: { query: "up" } },
        { id: "call_fail", name: "query_prometheus", args: { query: "bad" } },
      ],
    });
    mock.mockResponse({ type: "text", content: "Got partial results." });

    (mockMcp.callTool as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ text: "1.0", images: [] })
      .mockRejectedValueOnce(new Error("MCP process crashed"));

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({ mode: "proactive", message: "Check metrics." });

    expect(result.response).toBe("Got partial results.");

    const secondCallMessages = (mock.llm as any).chatStream.mock.calls[1][0];
    const toolMessages = secondCallMessages.filter(
      (m: { role: string }) => m.role === "tool"
    ) as { role: string; content: string; tool_call_id: string }[];

    // The successful tool result must be present
    const successMsg = toolMessages.find((m) => m.tool_call_id === "call_ok");
    expect(successMsg).toBeDefined();
    expect(successMsg!.content).toBe("1.0");

    // The failed tool result must carry the transport error
    const errorMsg = toolMessages.find((m) => m.tool_call_id === "call_fail");
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.content).toContain("[Transport Error]");
    expect(errorMsg!.content).toContain("MCP process crashed");
  });

  it("returns updatedHistory including new exchange", async () => {
    mock.mockResponse({ type: "text", content: "Done." });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({ mode: "conversational", message: "Hello." });

    const userMsg = result.updatedHistory.find((m) => m.role === "user" && m.content === "Hello.");
    const assistantMsg = result.updatedHistory.find((m) => m.role === "assistant" && m.content === "Done.");
    expect(userMsg).toBeDefined();
    expect(assistantMsg).toBeDefined();
  });

  it("records correlationId in task", async () => {
    // verify agent.run() accepts a correlationId without throwing
    mock.mockResponse({ type: "text", content: "Hello response." });
    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({
      mode: "conversational",
      message: "hello",
      correlationId: "test-id-123",
    });
    expect(result.response).toBeDefined();
  });

  it("fires onTokenUsage callback for each LLM call", async () => {
    mock.mockResponse({
      type: "tool_calls",
      usage: { inputTokens: 100, outputTokens: 20 },
      calls: [{ id: "call_1", name: "query_prometheus", args: { query: "up" } }],
    });
    mock.mockResponse({
      type: "text",
      content: "Done.",
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "1.0", images: [] });

    const onTokenUsage = vi.fn();
    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    await core.chat({
      mode: "conversational",
      message: "Check metrics.",
      onTokenUsage,
    });

    expect(onTokenUsage).toHaveBeenCalledTimes(2);
    expect(onTokenUsage).toHaveBeenNthCalledWith(1, { inputTokens: 100, outputTokens: 20 });
    expect(onTokenUsage).toHaveBeenNthCalledWith(2, { inputTokens: 200, outputTokens: 50 });
  });

  it("does not fail when onTokenUsage is not provided and usage is present", async () => {
    mock.mockResponse({
      type: "text",
      content: "OK.",
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({ mode: "conversational", message: "Hi." });
    expect(result.response).toBe("OK.");
  });

  it("skips onTokenUsage callback when usage is absent", async () => {
    mock.mockResponse({ type: "text", content: "No usage." });

    const onTokenUsage = vi.fn();
    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    await core.chat({ mode: "conversational", message: "Hi.", onTokenUsage });

    expect(onTokenUsage).not.toHaveBeenCalled();
  });

  it("uses structured response format for proactive mode", async () => {
    const assessment = {
      isAnomaly: false,
      severity: "low",
      summary: "All good",
      affectedMetrics: [],
      recommendedAction: "none",
    };
    mock.mockResponse({ type: "text", content: JSON.stringify(assessment) });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({
      mode: "proactive",
      message: "Check service: payments",
      serviceContext: [],
    });
    expect(result.response).toContain("isAnomaly");
    // Verify chatStream was called with responseFormat
    const callArgs = (mock.llm as any).chatStream.mock.calls[
      (mock.llm as any).chatStream.mock.calls.length - 1
    ];
    expect(callArgs[2]?.responseFormat).toBeDefined();
  });

  it("collects images from tool results and returns them in ChatResponse", async () => {
    mock.mockResponse({
      type: "tool_calls",
      calls: [{ id: "call_img", name: "get_panel_image", args: { dashboardUid: "abc", panelId: 1 } }],
    });
    mock.mockResponse({ type: "text", content: "Here is your chart." });

    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Panel rendered",
      images: [{ mimeType: "image/png", data: "aWJhc2U2NA==" }],
    });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({ mode: "conversational", message: "Show me the error rate chart." });

    expect(result.images).toHaveLength(1);
    expect(result.images[0].filename).toMatch(/^get_panel_image-.+\.png$/);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.images[0].data).toBeInstanceOf(Buffer);
  });

  it("appends image-captured hint to tool result text when images present", async () => {
    mock.mockResponse({
      type: "tool_calls",
      calls: [{ id: "call_img", name: "get_panel_image", args: {} }],
    });
    mock.mockResponse({ type: "text", content: "Done." });

    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Panel rendered",
      images: [{ mimeType: "image/png", data: "abc" }],
    });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    await core.chat({ mode: "conversational", message: "Chart." });

    const secondCallMessages = (mock.llm as any).chatStream.mock.calls[1][0];
    const toolMsg = secondCallMessages.find(
      (m: { role: string }) => m.role === "tool"
    );
    expect(toolMsg.content).toContain("chart image");
  });

  it("returns empty images array when no tool calls produce images", async () => {
    mock.mockResponse({ type: "text", content: "All good." });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({ mode: "conversational", message: "status?" });

    expect(result.images).toEqual([]);
  });

  it("strips base64 image markdown from LLM text response", async () => {
    mock.mockResponse({
      type: "text",
      content: 'Here is the chart:\n\n![System Load](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...)\n\nLooks healthy.',
    });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({ mode: "conversational", message: "show chart" });

    expect(result.response).not.toContain("data:image");
    expect(result.response).toContain("Here is the chart:");
    expect(result.response).toContain("Looks healthy.");
  });

  it("calls onToolCall callback before executing each tool", async () => {
    const onToolCall = vi.fn();
    mock.mockResponse({
      type: "tool_calls",
      calls: [
        { id: "call_1", name: "query_prometheus", args: { query: "up" } },
        { id: "call_2", name: "query_loki", args: { query: "{app=\"x\"}" } },
      ],
    });
    mock.mockResponse({ type: "text", content: "Done." });

    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "data", images: [] });

    const core = new ChatAgent(mock.llm, mockMcp, { maxIterations: 10 });
    await core.chat({ mode: "conversational", message: "check", onToolCall });

    // Called twice per tool: once before (no result), once after (with result)
    expect(onToolCall).toHaveBeenCalledTimes(4);
    expect(onToolCall).toHaveBeenCalledWith("query_prometheus", { query: "up" });
    expect(onToolCall).toHaveBeenCalledWith("query_prometheus", { query: "up" }, "data");
    expect(onToolCall).toHaveBeenCalledWith("query_loki", { query: "{app=\"x\"}" });
    expect(onToolCall).toHaveBeenCalledWith("query_loki", { query: "{app=\"x\"}" }, "data");
  });
});

describe("ChatAgent – transient error recovery", () => {
  it("returns a Connection error response on premature close instead of throwing", async () => {
    const llm = {
      chatStream: vi.fn(async function* (): AsyncGenerator<LlmStreamEvent> {
        throw new Error("premature close");
      }),
      chat: vi.fn(),
    } as unknown as LlmClient;

    const core = new ChatAgent(llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({ mode: "conversational", message: "Hi" });

    expect(result.response).toContain("Connection error");
  });
});

describe("ChatAgent – streaming", () => {
  it("calls onStreamStart and onStreamDelta for text response", async () => {
    const llm = makeMockLlm([
      [
        { type: "content", content: "Hello " },
        { type: "content", content: "world" },
        { type: "done" },
      ],
    ]) as unknown as LlmClient;

    const onStreamStart = vi.fn();
    const onStreamDelta = vi.fn();

    const core = new ChatAgent(llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({
      mode: "conversational",
      message: "Hi",
      onStreamStart,
      onStreamDelta,
    });

    expect(result.response).toBe("Hello world");
    expect(onStreamStart).toHaveBeenCalledTimes(1);
    expect(onStreamDelta).toHaveBeenCalledTimes(2);
    expect(onStreamDelta).toHaveBeenNthCalledWith(1, { type: "content", content: "Hello " });
    expect(onStreamDelta).toHaveBeenNthCalledWith(2, { type: "content", content: "world" });
  });

  it("forwards reasoning deltas via onStreamDelta but excludes them from response", async () => {
    const llm = makeMockLlm([
      [
        { type: "reasoning", content: "Thinking..." },
        { type: "content", content: "Hello" },
        { type: "done" },
      ],
    ]) as unknown as LlmClient;

    const onStreamDelta = vi.fn();

    const core = new ChatAgent(llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({
      mode: "conversational",
      message: "Hi",
      onStreamDelta,
    });

    expect(result.response).toBe("Hello");
    expect(onStreamDelta).toHaveBeenCalledTimes(2);
    expect(onStreamDelta).toHaveBeenNthCalledWith(1, { type: "reasoning", content: "Thinking..." });
    expect(onStreamDelta).toHaveBeenNthCalledWith(2, { type: "content", content: "Hello" });
  });

  it("does not call onStreamStart during tool-call iterations", async () => {
    const llm = makeMockLlm([
      // First iteration: tool call only (no reasoning/content)
      [
        { type: "tool_calls", calls: [{ id: "c1", name: "query_prometheus", args: { query: "up" } }] },
        { type: "done" },
      ],
      // Second iteration: text response
      [
        { type: "content", content: "All good." },
        { type: "done" },
      ],
    ]) as unknown as LlmClient;

    (mockMcp.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "1.0", images: [] });

    const onStreamStart = vi.fn();
    const onStreamDelta = vi.fn();

    const core = new ChatAgent(llm, mockMcp, { maxIterations: 10 });
    const result = await core.chat({
      mode: "conversational",
      message: "Check",
      onStreamStart,
      onStreamDelta,
    });

    expect(result.response).toBe("All good.");
    // onStreamStart fires only once — for the second iteration (text response)
    expect(onStreamStart).toHaveBeenCalledTimes(1);
    // onStreamDelta fires only for the content delta in the second iteration
    expect(onStreamDelta).toHaveBeenCalledTimes(1);
    expect(onStreamDelta).toHaveBeenCalledWith({ type: "content", content: "All good." });
  });
});

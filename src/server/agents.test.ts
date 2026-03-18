import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MastraChatAgentAdapter,
  MastraInvestigationAdapter,
  MastraDiscoverAdapter,
  createMastraAdapters,
} from "./agents.js";
import type { ChatRequest } from "../types/agent-types.js";
import type { WorkflowConfig } from "../workflows/investigation.js";

const {
  mockCreateChatAgent,
  mockGetAllTools,
  mockCreateModel,
  mockRunStart,
  mockCreateRun,
} = vi.hoisted(() => {
  const runStart = vi.fn();
  return {
    mockCreateChatAgent: vi.fn(),
    mockGetAllTools: vi.fn(),
    mockCreateModel: vi.fn(() => ({ provider: "model" })),
    mockRunStart: runStart,
    mockCreateRun: vi.fn().mockResolvedValue({
      start: runStart,
    }),
  };
});

vi.mock("../agents/chat.js", () => ({
  createChatAgent: mockCreateChatAgent,
}));

vi.mock("../mcp/provider.js", () => ({
  getAllTools: mockGetAllTools,
}));

vi.mock("../mastra/index.js", () => ({
  createModel: mockCreateModel,
}));

vi.mock("../workflows/investigation.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../workflows/investigation.js")>();
  return {
    ...original,
    createInvestigationWorkflow: vi.fn(() => ({
      createRun: mockCreateRun,
    })),
  };
});

function createFullStream(chunks: any[]) {
  return {
    fullStream: (async function* stream() {
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunStart.mockResolvedValue({
    status: "success",
    result: {
      severity: "high",
      summary: "Connection pool exhaustion",
      rootCause: "Leaked database connections after deploy v2.3.1",
      trigger: "Deploy of v2.3.1",
      confidence: "high",
      confidenceScore: 0.85,
      savedToHistory: true,
      investigatedAt: "2026-03-14T12:00:00Z",
    },
  });
});

describe("MastraChatAgentAdapter", () => {
  it("streams response text and includes history and skill context in the prompt", async () => {
    const inlineStream = vi.fn().mockResolvedValue(createFullStream([
      { type: "reasoning-delta", payload: { textDelta: "Thinking..." } },
      { type: "text-delta", payload: { textDelta: "CPU looks " } },
      { type: "text-delta", payload: { textDelta: "healthy." } },
    ]));
    const inlineGenerate = vi.fn();
    const adapter = new MastraChatAgentAdapter({
      inlineCharts: { stream: inlineStream, generate: inlineGenerate } as any,
      imageAttachments: { stream: vi.fn(), generate: vi.fn() } as any,
    });

    const onStreamStart = vi.fn();
    const onStreamDelta = vi.fn();
    const request: ChatRequest = {
      mode: "conversational",
      message: "what about now?",
      history: [
        { role: "user", content: "check cpu" },
        { role: "assistant", content: "CPU is at 80%" },
      ],
      skillContext: "### Skill: CPU Runbook\nCheck saturation first.",
      onStreamStart,
      onStreamDelta,
      supportsInlineCharts: true,
    };

    const response = await adapter.chat(request);

    expect(inlineStream).toHaveBeenCalledOnce();
    const prompt = inlineStream.mock.calls[0]?.[0];
    expect(prompt).toContain("### Skill: CPU Runbook");
    expect(prompt).toContain("check cpu");
    expect(prompt).toContain("CPU is at 80%");
    expect(prompt).toContain("USER: what about now?");
    expect(onStreamStart).toHaveBeenCalledOnce();
    expect(onStreamDelta).toHaveBeenNthCalledWith(1, {
      type: "reasoning",
      content: "Thinking...",
    });
    expect(onStreamDelta).toHaveBeenNthCalledWith(2, {
      type: "content",
      content: "CPU looks ",
    });
    expect(onStreamDelta).toHaveBeenNthCalledWith(3, {
      type: "content",
      content: "healthy.",
    });
    expect(response.response).toBe("CPU looks healthy.");
    expect(response.images).toEqual([]);
  });

  it("uses the attachment agent and preserves image attachments for CLI chat", async () => {
    const attachmentStream = vi.fn().mockResolvedValue(createFullStream([
      { type: "tool-call", payload: { toolName: "grafana_get_panel_image", args: { panelUid: "abc" } } },
      {
        type: "tool-result",
        payload: {
          toolName: "grafana_get_panel_image",
          args: { panelUid: "abc" },
          result: {
            content: [
              { type: "text", text: "Fetched panel image" },
              { type: "image", data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" },
            ],
          },
        },
      },
      { type: "text-delta", payload: { textDelta: "Saved the panel snapshot." } },
    ]));
    const onToolCall = vi.fn();
    const adapter = new MastraChatAgentAdapter({
      inlineCharts: { stream: vi.fn(), generate: vi.fn() } as any,
      imageAttachments: { stream: attachmentStream, generate: vi.fn() } as any,
    });

    const response = await adapter.chat({
      mode: "conversational",
      message: "show me a chart",
      supportsInlineCharts: false,
      onToolCall,
    });

    expect(attachmentStream).toHaveBeenCalledOnce();
    expect(onToolCall).toHaveBeenCalledWith("get_panel_image", { panelUid: "abc" });
    expect(onToolCall).toHaveBeenCalledWith("get_panel_image", { panelUid: "abc" }, "Fetched panel image");
    expect(response.response).toBe("Saved the panel snapshot.");
    expect(response.images).toHaveLength(1);
    expect(response.images[0]?.mimeType).toBe("image/png");
    expect(response.images[0]?.data).toEqual(Buffer.from("fake-png"));
  });

  it("falls back to generate when stream fails", async () => {
    const inlineStream = vi.fn().mockRejectedValue(new Error("stream broke"));
    const inlineGenerate = vi.fn().mockResolvedValue({ text: "Fallback response" });
    const onStreamDelta = vi.fn();
    const adapter = new MastraChatAgentAdapter({
      inlineCharts: { stream: inlineStream, generate: inlineGenerate } as any,
      imageAttachments: { stream: vi.fn(), generate: vi.fn() } as any,
    });

    const response = await adapter.chat({
      mode: "conversational",
      message: "test",
      onStreamDelta,
      supportsInlineCharts: true,
    });

    expect(inlineGenerate).toHaveBeenCalledWith(expect.stringContaining("USER: test"));
    expect(onStreamDelta).toHaveBeenCalledWith({
      type: "content",
      content: "Fallback response",
    });
    expect(response.response).toBe("Fallback response");
  });
});

describe("MastraInvestigationAdapter", () => {
  it("runs the investigation workflow and returns RcaReport", async () => {
    const config: WorkflowConfig = {
      model: {} as any,
      providers: [],
      services: [],
      projectRoot: "/tmp/test",
    };

    const adapter = new MastraInvestigationAdapter(config);
    const report = await adapter.investigate(
      { name: "payments", metrics: [], logLabels: {} },
      undefined,
      undefined,
      undefined,
      "investigate high latency on payments",
    );

    expect(report.service).toBe("payments");
    expect(report.severity).toBe("high");
    expect(report.rootCause).toBe("Leaked database connections after deploy v2.3.1");
    expect(report.confidence).toBe("high");
    expect(report.confidenceScore).toBe(0.85);
  });

  it("passes progress callbacks and skillContext through to the workflow", async () => {
    const { createInvestigationWorkflow } = await import("../workflows/investigation.js");
    const config: WorkflowConfig = {
      model: {} as any,
      providers: [],
      services: [],
      projectRoot: "/tmp/test",
    };

    const adapter = new MastraInvestigationAdapter(config);
    const onPhase = vi.fn();
    const onIteration = vi.fn();
    const onToolCall = vi.fn();

    await adapter.investigate(
      { name: "api-gateway", metrics: [], logLabels: {} },
      undefined,
      undefined,
      undefined,
      "investigate",
      onToolCall,
      onPhase,
      onIteration,
      "### Skill: API Runbook\nCheck the load balancer first.",
    );

    expect(vi.mocked(createInvestigationWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({
        onPhase,
        onIteration,
        onToolCall,
      }),
      undefined,
    );
    expect(mockRunStart).toHaveBeenCalledWith({
      inputData: expect.objectContaining({
        serviceName: "api-gateway",
        skillContext: "### Skill: API Runbook\nCheck the load balancer first.",
      }),
    });
  });

  it("returns a default report when the workflow fails", async () => {
    mockRunStart.mockResolvedValueOnce({
      status: "failed",
      result: null,
    });

    const config: WorkflowConfig = {
      model: {} as any,
      providers: [],
      services: [],
      projectRoot: "/tmp/test",
    };

    const adapter = new MastraInvestigationAdapter(config);
    const report = await adapter.investigate(
      { name: "failing-svc", metrics: [], logLabels: {} },
      undefined,
      undefined,
      undefined,
      "investigate",
    );

    expect(report.service).toBe("failing-svc");
    expect(report.rootCause).toBe("Unable to determine root cause");
    expect(report.confidence).toBe("low");
  });
});

describe("MastraDiscoverAdapter", () => {
  it("exposes discover() and accept() methods", () => {
    const adapter = new MastraDiscoverAdapter({
      model: {} as any,
      providers: [],
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
      registryStore: { load: () => [], save: () => "id", listVersions: () => [], getVersion: () => [], rollback: () => {} } as any,
    });
    expect(typeof adapter.discover).toBe("function");
    expect(typeof adapter.accept).toBe("function");
  });
});

describe("createMastraAdapters", () => {
  it("creates separate web and CLI chat agents with different tool availability", async () => {
    mockGetAllTools.mockResolvedValue({
      grafana_query_prometheus: { execute: vi.fn() },
      grafana_get_panel_image: { execute: vi.fn() },
    });
    mockCreateChatAgent.mockImplementation((config) => ({
      id: config.agentId,
      stream: vi.fn(),
      generate: vi.fn(),
    }));

    await createMastraAdapters({
      config: {
        llm: { model: "gpt-4.1", maxTokens: 4096, apiKey: "test-key" },
        providers: [],
        services: [],
        agent: {
          maxIterations: 12,
          conversationMemory: { maxMessages: 20, ttlMinutes: 60 },
          investigationTriggerPhrases: [],
        },
        timeouts: { mcpConnectMs: 30_000, llmCallMs: 60_000, toolExecutionMs: 30_000, agentIterationMs: 90_000 },
        retry: { maxAttempts: 3, baseDelayMs: 500 },
        observability: { port: 9090, logLevel: "info" },
        skills: { dir: "./skills", maxPerQuery: 3, maxCharsPerSkill: 2000 },
        discovery: { autoRefresh: false, excludeServices: [], maxIterations: 40 },
        memory: { storage: "memory", dbPath: ".dops/memory.db" },
      },
      providers: [],
    } as any);

    expect(mockCreateChatAgent).toHaveBeenCalledTimes(2);
    expect(mockCreateChatAgent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      agentId: "chat-inline",
      supportsInlineCharts: true,
      tools: {
        grafana_query_prometheus: expect.any(Object),
      },
    }));
    expect(mockCreateChatAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agentId: "chat-attachments",
      supportsInlineCharts: false,
      tools: {
        grafana_query_prometheus: expect.any(Object),
        grafana_get_panel_image: expect.any(Object),
      },
    }));
  });

  const baseConfig = {
    llm: { model: "gpt-4o", maxTokens: 4096, apiKey: "test-key" },
    agent: { maxIterations: 10 },
    services: [{ name: "svc", metrics: [], logLabels: {} }],
  } as any;

  it("passes projectRoot=process.cwd() when noHistory is omitted", async () => {
    const { createInvestigationWorkflow } = await import("../workflows/investigation.js");
    vi.mocked(createInvestigationWorkflow).mockClear();

    const { investigationAgent } = await createMastraAdapters({ config: baseConfig, providers: [] });
    await investigationAgent.investigate(
      { name: "svc", metrics: [], logLabels: {} },
      undefined,
      undefined,
      undefined,
      "test",
    );

    expect(vi.mocked(createInvestigationWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: process.cwd() }),
      undefined,
    );
  });

  it("passes projectRoot=undefined when noHistory is true", async () => {
    const { createInvestigationWorkflow } = await import("../workflows/investigation.js");
    vi.mocked(createInvestigationWorkflow).mockClear();

    const { investigationAgent } = await createMastraAdapters({
      config: baseConfig,
      providers: [],
      noHistory: true,
    });

    await investigationAgent.investigate(
      { name: "svc", metrics: [], logLabels: {} },
      undefined,
      undefined,
      undefined,
      "test",
    );

    expect(vi.mocked(createInvestigationWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: undefined }),
      undefined,
    );
  });

  it("passes projectRoot=process.cwd() when noHistory is false", async () => {
    const { createInvestigationWorkflow } = await import("../workflows/investigation.js");
    vi.mocked(createInvestigationWorkflow).mockClear();

    const { investigationAgent } = await createMastraAdapters({
      config: baseConfig,
      providers: [],
      noHistory: false,
    });

    await investigationAgent.investigate(
      { name: "svc", metrics: [], logLabels: {} },
      undefined,
      undefined,
      undefined,
      "test",
    );

    expect(vi.mocked(createInvestigationWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: process.cwd() }),
      undefined,
    );
  });
});

/**
 * Integration tests for the Mastra adapter layer.
 * Verifies that the Mastra path can initialize and handle requests
 * without real MCP/LLM connections (mocked).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MastraChatAgentAdapter,
  MastraInvestigationAdapter,
  createMastraAdapters,
} from "./mastra-adapter.js";
import type { ChatRequest } from "../agent/types.js";
import type { WorkflowConfig } from "../workflows/investigation.js";

// Mock the Mastra agent generate() method
const mockGenerate = vi.fn();
vi.mock("../agents/chat.js", () => ({
  createChatAgent: vi.fn(() => ({
    name: "chat",
    generate: mockGenerate,
  })),
}));

// Mock the workflow
vi.mock("../workflows/investigation.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../workflows/investigation.js")>();
  return {
    ...original,
    createInvestigationWorkflow: vi.fn(() => ({
      createRun: vi.fn().mockResolvedValue({
        start: vi.fn().mockResolvedValue({
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
        }),
      }),
    })),
  };
});

describe("MastraChatAgentAdapter", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it("calls agent.generate() with the user message", async () => {
    mockGenerate.mockResolvedValue({ text: "Hello! I can help with DevOps." });

    const adapter = new MastraChatAgentAdapter({ generate: mockGenerate } as any);
    const request: ChatRequest = {
      mode: "conversational",
      message: "hello",
    };

    const response = await adapter.chat(request);

    expect(mockGenerate).toHaveBeenCalledOnce();
    expect(response.response).toBe("Hello! I can help with DevOps.");
    expect(response.images).toEqual([]);
  });

  it("calls onStreamStart and onStreamDelta", async () => {
    mockGenerate.mockResolvedValue({ text: "Response text" });

    const onStreamStart = vi.fn();
    const onStreamDelta = vi.fn();

    const adapter = new MastraChatAgentAdapter({ generate: mockGenerate } as any);
    const request: ChatRequest = {
      mode: "conversational",
      message: "test",
      onStreamStart,
      onStreamDelta,
    };

    await adapter.chat(request);

    expect(onStreamStart).toHaveBeenCalledOnce();
    expect(onStreamDelta).toHaveBeenCalledWith({
      type: "content",
      content: "Response text",
    });
  });

  it("handles errors gracefully", async () => {
    mockGenerate.mockRejectedValue(new Error("LLM timeout"));

    const adapter = new MastraChatAgentAdapter({ generate: mockGenerate } as any);
    const request: ChatRequest = {
      mode: "conversational",
      message: "test",
    };

    const response = await adapter.chat(request);

    expect(response.response).toContain("Error: LLM timeout");
  });

  it("includes message history in the prompt", async () => {
    mockGenerate.mockResolvedValue({ text: "ok" });

    const adapter = new MastraChatAgentAdapter({ generate: mockGenerate } as any);
    const request: ChatRequest = {
      mode: "conversational",
      message: "what about now?",
      history: [
        { role: "user" as const, content: "check cpu" },
        { role: "assistant" as const, content: "CPU is at 80%" },
      ],
    };

    await adapter.chat(request);

    const prompt = mockGenerate.mock.calls[0][0];
    expect(prompt).toContain("check cpu");
    expect(prompt).toContain("CPU is at 80%");
    expect(prompt).toContain("what about now?");
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
    const onPhase = vi.fn();
    const onIteration = vi.fn();

    const report = await adapter.investigate(
      { name: "payments", metrics: [], logLabels: {} },
      undefined,
      undefined,
      undefined,
      "investigate high latency on payments",
      undefined,
      onPhase,
      onIteration,
    );

    expect(report.service).toBe("payments");
    expect(report.severity).toBe("high");
    expect(report.rootCause).toBe("Leaked database connections after deploy v2.3.1");
    expect(report.confidence).toBe("high");
    expect(report.confidenceScore).toBe(0.85);
  });

  it("passes progress callbacks through to the workflow config", async () => {
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
    );

    // Verify the workflow was created with the callbacks wired into the config
    expect(vi.mocked(createInvestigationWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({
        onPhase,
        onIteration,
        onToolCall,
      }),
    );
  });

  it("returns default report when workflow fails", async () => {
    // Override the mock for this test to simulate failure
    const { createInvestigationWorkflow } = await import("../workflows/investigation.js");
    vi.mocked(createInvestigationWorkflow).mockReturnValueOnce({
      createRun: vi.fn().mockResolvedValue({
        start: vi.fn().mockResolvedValue({
          status: "failed",
          result: null,
        }),
      }),
    } as any);

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

    // Should return a default report, not crash
    expect(report.service).toBe("failing-svc");
    expect(report.rootCause).toBe("Unable to determine root cause");
    expect(report.confidence).toBe("low");
  });
});

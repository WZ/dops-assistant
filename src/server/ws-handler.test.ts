import { describe, it, expect, vi } from "vitest";
import { handleClientMessage } from "./ws-handler.js";
import type { WsDeps } from "./ws-handler.js";
import type { ServerMessage } from "../shared/ws-types.js";

function mockDeps(): WsDeps {
  return {
    db: {
      createInvestigation: vi.fn(),
      updateInvestigation: vi.fn(),
      createPhase: vi.fn(),
      updatePhase: vi.fn(),
      createMessage: vi.fn(),
      createEvent: vi.fn(),
      getInvestigation: vi.fn(),
      getPhases: vi.fn(() => []),
    },
    agent: {
      chat: vi.fn().mockResolvedValue({ response: "Hello!", history: [], images: [] }),
    },
    investigationAgent: {
      investigate: vi.fn().mockResolvedValue({
        service: "svc", severity: "low", summary: "All good",
        rootCause: "None", confidence: "low", trigger: "",
        impact: { duration: "", description: "" },
        contributingFactors: [], timeline: [],
        evidence: { metrics: [], logs: [], infra: [] },
        dashboardLinks: [], panelImages: [],
        recommendedActions: [], investigatedAt: new Date().toISOString(),
      }),
    },
    router: {
      route: vi.fn().mockResolvedValue({ intent: "question" }),
    },
    memory: {
      get: vi.fn().mockReturnValue([]),
      append: vi.fn(),
    },
    services: [{ name: "payments-api", metrics: [], logLabels: {} }],
    matchService: vi.fn(),
    matchServiceFromText: vi.fn(),
  } as unknown as WsDeps;
}

describe("handleClientMessage", () => {
  it("routes a question to ChatAgent and sends response", async () => {
    const deps = mockDeps();
    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await handleClientMessage({ type: "chat", message: "what dashboards?" }, send, deps, "thread_1");

    expect(deps.router.route).toHaveBeenCalledWith("what dashboards?", ["payments-api"]);
    expect(deps.agent.chat).toHaveBeenCalled();
    const chatMsg = messages.find((m: any) => m.type === "chat" && m.role === "assistant");
    expect(chatMsg).toBeDefined();
  });

  it("routes an investigation and emits lifecycle events", async () => {
    const deps = mockDeps();
    (deps.router.route as ReturnType<typeof vi.fn>).mockResolvedValue({ intent: "investigation", service: "payments-api" });
    (deps.matchService as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await handleClientMessage({ type: "chat", message: "investigate payments-api" }, send, deps, "thread_1");

    expect(messages.some((m: any) => m.type === "investigation:started")).toBe(true);
    expect(messages.some((m: any) => m.type === "investigation:complete")).toBe(true);
    expect(deps.db.createInvestigation).toHaveBeenCalled();
  });

  it("asks user to specify service when none matched", async () => {
    const deps = mockDeps();
    (deps.router.route as ReturnType<typeof vi.fn>).mockResolvedValue({ intent: "investigation", service: undefined });
    (deps.matchService as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await handleClientMessage({ type: "chat", message: "investigate something" }, send, deps, "thread_1");

    const chatMsg = messages.find((m: any) => m.type === "chat" && m.content?.includes("specify"));
    expect(chatMsg).toBeDefined();
  });
});

describe("handleClientMessage — enriched events", () => {
  it("should emit investigation:tool_call and investigation:iteration events", async () => {
    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    const mockInvestigationAgent = {
      investigate: vi.fn(async (
        _service: any, _anomaly: any, _id: any, _usage: any, _msg: any,
        onToolCall: any, onPhase: any, onIteration: any,
      ) => {
        onPhase?.("Detecting anomalies");
        onIteration?.("planning", 0, 3, "Starting anomaly detection");
        onToolCall?.("query_prometheus", { query: "up" });
        onToolCall?.("query_prometheus", { query: "up" }, '{"data":[]}', 150);
        onPhase?.("Analyzing metrics, logs & infrastructure");
        onToolCall?.("query_prometheus", { query: "rate(errors[5m])" }, '{"data":[]}', 2100);
        onPhase?.("Synthesizing root cause");
        return {
          rootCause: "Test root cause",
          trigger: "Test trigger",
          confidence: "high",
          severity: "medium",
          summary: "Test summary",
          impact: { duration: "1h", description: "Test impact" },
          contributingFactors: [],
          timeline: [],
          evidence: { metrics: [], logs: [], infra: [] },
          dashboardLinks: [],
          panelImages: [],
          recommendedActions: [],
          investigatedAt: new Date().toISOString(),
        };
      }),
    };

    const mockDeps = {
      db: {
        createMessage: vi.fn(),
        createEvent: vi.fn(),
        createInvestigation: vi.fn(),
        updateInvestigation: vi.fn(),
        getInvestigation: vi.fn(),
        getPhases: vi.fn(() => []),
        createPhase: vi.fn(),
        updatePhase: vi.fn(),
      },
      agent: {},
      investigationAgent: mockInvestigationAgent,
      router: { route: vi.fn(async () => ({ intent: "investigation", service: "test-service" })) },
      memory: { get: vi.fn(() => []), append: vi.fn() },
      services: [{ name: "test-service", metrics: [], logLabels: {} }],
      matchService: vi.fn((_q: string | undefined, services: any[]) => services[0]),
      matchServiceFromText: vi.fn(() => undefined),
    };

    await handleClientMessage(
      { type: "chat", message: "investigate test-service" },
      send,
      mockDeps as any,
      "test_thread",
    );

    // Check tool_call events were emitted
    const toolCallEvents = sent.filter((m) => m.type === "investigation:tool_call");
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(2);

    // Check at least one has "success" status with duration
    const successCalls = toolCallEvents.filter((m) => m.type === "investigation:tool_call" && m.status === "success");
    expect(successCalls.length).toBeGreaterThanOrEqual(1);
    const firstSuccess = successCalls[0] as Extract<ServerMessage, { type: "investigation:tool_call" }>;
    expect(firstSuccess.durationMs).toBeDefined();

    // Check iteration events were emitted
    const iterationEvents = sent.filter((m) => m.type === "investigation:iteration");
    expect(iterationEvents.length).toBeGreaterThanOrEqual(1);
    const firstIteration = iterationEvents[0] as Extract<ServerMessage, { type: "investigation:iteration" }>;
    expect(firstIteration.iteration).toBe(0);
    expect(firstIteration.maxIterations).toBe(3);

    // Check phase events were emitted
    const phaseEvents = sent.filter((m) => m.type === "investigation:phase");
    expect(phaseEvents.length).toBeGreaterThan(0);

    // Check investigation:complete was emitted
    const completeEvents = sent.filter((m) => m.type === "investigation:complete");
    expect(completeEvents.length).toBe(1);
  });

  it("should handle deep_investigate messages", async () => {
    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    const mockDeps = {
      db: {
        createMessage: vi.fn(),
        createEvent: vi.fn(),
        createInvestigation: vi.fn(),
        updateInvestigation: vi.fn(),
        getInvestigation: vi.fn(() => ({
          id: "inv_test",
          service: "test-service",
          query: "test query",
          status: "complete",
          report: JSON.stringify({ rootCause: "test", trigger: "test", severity: "medium", confidence: "high", summary: "test" }),
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        })),
        getPhases: vi.fn(() => []),
        createPhase: vi.fn(),
        updatePhase: vi.fn(),
      },
      agent: {
        chat: vi.fn(async () => ({ response: "Here is my analysis..." })),
      },
      investigationAgent: {},
      router: { route: vi.fn() },
      memory: { get: vi.fn(() => []), append: vi.fn() },
      services: [{ name: "test-service", metrics: [], logLabels: {} }],
      matchService: vi.fn(),
      matchServiceFromText: vi.fn(),
    };

    await handleClientMessage(
      { type: "deep_investigate", investigationId: "inv_test", message: "Why did this happen?" },
      send,
      mockDeps as any,
      "test_thread",
    );

    const responses = sent.filter((m) => m.type === "deep_investigate:response");
    expect(responses.length).toBe(1);
    const response = responses[0] as Extract<ServerMessage, { type: "deep_investigate:response" }>;
    expect(response.investigationId).toBe("inv_test");
    expect(response.content).toBe("Here is my analysis...");
  });

  it("should return error for non-existent investigation in deep_investigate", async () => {
    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    const mockDeps = {
      db: {
        getInvestigation: vi.fn(() => undefined),
        getPhases: vi.fn(() => []),
        createMessage: vi.fn(),
        createEvent: vi.fn(),
        createInvestigation: vi.fn(),
        updateInvestigation: vi.fn(),
        createPhase: vi.fn(),
        updatePhase: vi.fn(),
      },
      agent: {},
      investigationAgent: {},
      router: { route: vi.fn() },
      memory: { get: vi.fn(() => []), append: vi.fn() },
      services: [],
      matchService: vi.fn(),
      matchServiceFromText: vi.fn(),
    };

    await handleClientMessage(
      { type: "deep_investigate", investigationId: "inv_nonexistent", message: "test" },
      send,
      mockDeps as any,
      "test_thread",
    );

    const responses = sent.filter((m) => m.type === "deep_investigate:response");
    expect(responses.length).toBe(1);
    const response = responses[0] as Extract<ServerMessage, { type: "deep_investigate:response" }>;
    expect(response.content).toContain("not found");
  });
});

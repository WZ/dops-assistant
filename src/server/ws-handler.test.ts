import { describe, it, expect, vi } from "vitest";
import { handleClientMessage } from "./ws-handler.js";
import type { WsDeps } from "./ws-handler.js";
import type { ServerMessage } from "../types/ws-types.js";
import type { StackContext } from "./stack-manager.js";

// Mock createMastraAdapters so we can control what agents are returned
vi.mock("./agents.js", () => ({
  createMastraAdapters: vi.fn().mockResolvedValue({
    chatAgent: {
      chat: vi.fn().mockResolvedValue({ response: "Hello!", history: [], images: [] }),
    },
    investigationAgent: {
      investigate: vi.fn().mockResolvedValue({
        service: "svc", severity: "low", summary: "All good",
        rootCause: "None", confidence: "low", trigger: "",
        impact: { duration: "", description: "" },
        contributingFactors: [], timeline: [],
        evidence: { metrics: [], logs: [], infra: [] },
        dashboardLinks: [],
        recommendedActions: [], investigatedAt: new Date().toISOString(),
      }),
    },
    discoverAgent: undefined,
  }),
}));

vi.mock("../mcp/provider.js", () => ({
  getToolsByRole: vi.fn().mockResolvedValue({}),
  getAllTools: vi.fn().mockResolvedValue({}),
}));

const S = "test-stack";

function mockCtx(): StackContext {
  return {
    id: S,
    slug: "default",
    name: "Default",
    providerRegistry: {
      getProviders: vi.fn().mockReturnValue([]),
      getAll: vi.fn().mockReturnValue([]),
      initialize: vi.fn().mockResolvedValue(undefined),
    },
    conversationMemory: {
      get: vi.fn().mockReturnValue([]),
      append: vi.fn(),
      clear: vi.fn(),
    },
    serviceRegistry: {
      load: vi.fn().mockReturnValue([]),
      save: vi.fn(),
    },
    healthPoller: {
      start: vi.fn(),
      stop: vi.fn(),
      getHealth: vi.fn().mockReturnValue(new Map()),
      getSummary: vi.fn(),
    },
  } as unknown as StackContext;
}

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
      listRecentMessages: vi.fn(() => []),
      listMessages: vi.fn(() => []),
      getHiddenServices: vi.fn(() => new Set()),
      getDisabledSkills: vi.fn(() => new Set()),
    },
    stackManager: {
      resolveStackId: vi.fn().mockReturnValue(S),
      getContext: vi.fn().mockReturnValue(mockCtx()),
      getDefaultStackId: vi.fn().mockReturnValue(S),
    },
    config: {
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
      discovery: { autoRefresh: false, excludeServices: [], maxIterations: 40 },
      llm: { model: "gpt-4", maxTokens: 4096, apiKey: "test" },
      agent: { maxIterations: 20, conversationMemory: { maxMessages: 50, ttlMinutes: 30 } },
    },
    router: {
      route: vi.fn().mockResolvedValue({ intent: "question" }),
    },
    skillStore: undefined,
    sharedDedup: {
      shouldInvestigate: vi.fn().mockReturnValue(true),
      markStarted: vi.fn(),
      markCompleted: vi.fn(),
      getActiveCount: vi.fn().mockReturnValue(0),
    },
    validateLlmServiceMatch: vi.fn(),
    matchServiceFromText: vi.fn(),
  } as unknown as WsDeps;
}

function callHandler(msg: any, send: (m: ServerMessage) => void, deps: WsDeps, ctx?: StackContext) {
  const context = ctx ?? mockCtx();
  return handleClientMessage(
    msg, send, deps, `stack_${S}_web_test`,
    S, context,
    () => null, () => {},
  );
}

describe("handleClientMessage", () => {
  it("routes a question to ChatAgent and sends response", async () => {
    const deps = mockDeps();
    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await callHandler({ type: "chat", message: "what dashboards?" }, send as any, deps);

    expect(deps.router.route).toHaveBeenCalledWith("what dashboards?", ["payments-api"]);
    const streamEnd = messages.find((m: any) => m.type === "chat:stream_end");
    expect(streamEnd).toBeDefined();
  });

  it("routes an investigation and emits lifecycle events", async () => {
    const deps = mockDeps();
    (deps.router.route as ReturnType<typeof vi.fn>).mockResolvedValue({ intent: "investigation", service: "payments-api" });
    (deps.validateLlmServiceMatch as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await callHandler({ type: "chat", message: "investigate payments-api" }, send as any, deps);

    expect(messages.some((m: any) => m.type === "investigation:started")).toBe(true);
    expect(messages.some((m: any) => m.type === "investigation:complete")).toBe(true);
    expect(deps.db.createInvestigation).toHaveBeenCalled();
  });

  it("asks user to specify service when none matched", async () => {
    const deps = mockDeps();
    (deps.router.route as ReturnType<typeof vi.fn>).mockResolvedValue({ intent: "investigation", service: undefined });
    (deps.validateLlmServiceMatch as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await callHandler({ type: "chat", message: "investigate something" }, send as any, deps);

    const chatMsg = messages.find((m: any) => m.type === "chat" && m.content?.includes("specify"));
    expect(chatMsg).toBeDefined();
  });
});

describe("handleClientMessage — new_session", () => {
  it("clears memory and sends session_cleared", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();
    const messages: ServerMessage[] = [];
    const send = (msg: ServerMessage) => messages.push(msg);

    await callHandler({ type: "new_session" }, send, deps, ctx);

    expect(ctx.conversationMemory.clear).toHaveBeenCalled();
    expect(messages).toEqual([{ type: "session_cleared" }]);
  });
});

describe("handleClientMessage — context_switch", () => {
  it("sends context_switch when user switches from one service to another", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();
    (deps.config as any).services = [
      { name: "ingestion-server", metrics: [], logLabels: {} },
      { name: "kudu-tserver", metrics: [], logLabels: {} },
    ];
    // matchServiceFromText detects "kudu" in the current message
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue({ name: "kudu-tserver", metrics: [], logLabels: {} });
    // memory has prior conversation about ingestion-server
    (ctx.conversationMemory.get as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: "user", content: "how is the ingestion-server?" },
      { role: "assistant", content: "The ingestion-server log rate is 5k/s." },
    ]);

    const messages: ServerMessage[] = [];
    const send = (msg: ServerMessage) => messages.push(msg);

    await callHandler({ type: "chat", message: "how's the kudu workload rate" }, send, deps, ctx);

    const switchMsg = messages.find((m) => m.type === "context_switch");
    expect(switchMsg).toBeDefined();
    if (switchMsg && switchMsg.type === "context_switch") {
      expect(switchMsg.previousService).toBe("ingestion-server");
      expect(switchMsg.newService).toBe("kudu-tserver");
    }
  });
});

describe("handleClientMessage — deep_investigate", () => {
  it("should return error for non-existent investigation", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    await callHandler(
      { type: "deep_investigate", investigationId: "inv_nonexistent", message: "test" },
      send, deps, ctx,
    );

    const responses = sent.filter((m) => m.type === "chat:stream_end");
    expect(responses.length).toBe(1);
    expect((responses[0] as any).content).toContain("not found");
  });
});

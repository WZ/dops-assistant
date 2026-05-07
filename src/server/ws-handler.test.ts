import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import WebSocket from "ws";
import { clearStackCaches, handleClientMessage, setupWebSocket } from "./ws-handler.js";
import type { WsDeps } from "./ws-handler.js";
import type { ServerMessage } from "../types/ws-types.js";
import type { StackContext } from "./stack-manager.js";
import { createMastraAdapters } from "./agents.js";
import { getToolsByRole } from "../mcp/provider.js";

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
      // Default to a single healthy provider so chat tests exercise the
      // normal LLM path. Tests that need the "no reachable providers"
      // short-circuit (ws-handler.ts ~line 1020) override this mock.
      getAll: vi.fn().mockReturnValue([
        { config: { name: "test", roles: ["metrics"] }, source: "config", status: "connected", toolCount: 1, enabledToolCount: 1 },
      ]),
      initialize: vi.fn().mockResolvedValue(undefined),
      buildDatasourceUidMap: vi.fn().mockReturnValue(new Map()),
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
      llm: { model: "gpt-4", apiKey: "test" },
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
    // Skip the 5s confirm-dispatch window in tests by default.
    chatDispatchConfirmMs: 0,
  } as unknown as WsDeps;
}

function callHandler(
  msg: any,
  send: (m: ServerMessage) => void,
  deps: WsDeps,
  ctx?: StackContext,
  pendingDispatches?: Map<string, AbortController>,
) {
  const context = ctx ?? mockCtx();
  return handleClientMessage(
    msg, send, deps, `stack_${S}_web_test`,
    S, context,
    () => null, () => {},
    () => {},
    pendingDispatches,
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

  it("slash command: /investigate strips prefix, skips router, dispatches investigation", async () => {
    const deps = mockDeps();
    // Slash path skips the router entirely
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await callHandler({ type: "chat", message: "/investigate the timeout in payments-api" }, send as any, deps);

    expect(deps.router.route).not.toHaveBeenCalled();
    // Service-resolution lookup should have used the STRIPPED message
    expect(deps.matchServiceFromText).toHaveBeenCalledWith(
      "the timeout in payments-api",
      expect.anything(),
    );
    // The runner sees the stripped message via investigation:started.query
    const started = messages.find((m: any) => m.type === "investigation:started");
    expect(started).toBeDefined();
    if (started && (started as any).type === "investigation:started") {
      expect((started as any).query).toBe("the timeout in payments-api");
    }
    // Confirm-dispatch was emitted (timerMs=0 in tests, so it doesn't block)
    expect(messages.some((m: any) => m.type === "investigation:confirm_dispatch")).toBe(true);
  });

  it("slash command without resolvable service replies with help, no dispatch", async () => {
    const deps = mockDeps();
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (deps.validateLlmServiceMatch as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await callHandler({ type: "chat", message: "/investigate" }, send as any, deps);

    // No router call — slash path bypasses it
    expect(deps.router.route).not.toHaveBeenCalled();
    // No investigation dispatched
    expect(messages.some((m: any) => m.type === "investigation:started")).toBe(false);
    expect(messages.some((m: any) => m.type === "investigation:confirm_dispatch")).toBe(false);
    // Help reply present and tells the user how to retry
    const help = messages.find((m: any) => m.type === "chat" && m.content?.includes("/investigate"));
    expect(help).toBeDefined();
  });

  it("slash command does NOT fall back to history-resolved service", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();
    // Even though history mentions a service, slash without an explicit target
    // should NOT pick up that service.
    (ctx.conversationMemory.get as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: "user", content: "tell me about ingestion-server" },
    ]);
    (deps.config as any).services = [{ name: "ingestion-server", metrics: [], logLabels: {} }];
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (deps.validateLlmServiceMatch as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await callHandler({ type: "chat", message: "/investigate the timeout spike" }, send as any, deps, ctx);

    // No silent dispatch on the history-resolved service
    expect(messages.some((m: any) => m.type === "investigation:started")).toBe(false);
    const help = messages.find((m: any) => m.type === "chat" && m.content?.includes("/investigate"));
    expect(help).toBeDefined();
  });

  it("cancel_dispatch within window aborts the runner and emits dispatch_cancelled", async () => {
    const deps = mockDeps();
    // Set a small but non-zero window so the cancel can race
    deps.chatDispatchConfirmMs = 200;
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });

    const ctx = mockCtx();
    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);
    const pendingDispatches = new Map<string, AbortController>();

    const chatPromise = callHandler(
      { type: "chat", message: "/investigate payments-api" },
      send as any,
      deps,
      ctx,
      pendingDispatches,
    );

    // Wait one tick so the chat handler emits confirm_dispatch and registers the controller
    await new Promise((r) => setTimeout(r, 10));
    const confirm = messages.find((m: any) => m.type === "investigation:confirm_dispatch");
    expect(confirm).toBeDefined();
    const invId = confirm && (confirm as any).type === "investigation:confirm_dispatch" ? (confirm as any).id : undefined;
    expect(invId).toBeTruthy();

    // Cancel through the same handler entry — same pendingDispatches map
    await callHandler(
      { type: "investigation:cancel_dispatch", id: invId! },
      send as any,
      deps,
      ctx,
      pendingDispatches,
    );

    await chatPromise;

    expect(messages.some((m: any) => m.type === "investigation:dispatch_cancelled")).toBe(true);
    // No started/runner activity after cancel
    expect(messages.some((m: any) => m.type === "investigation:started")).toBe(false);
    // Cancelled chat reply present
    const cancelMsg = messages.find((m: any) => m.type === "chat" && m.content?.includes("cancelled"));
    expect(cancelMsg).toBeDefined();
    // Pending dispatch was removed
    expect(pendingDispatches.has(invId!)).toBe(false);
  });

  it("chat:stream_end carries serviceContext for resolved-service replies", async () => {
    const deps = mockDeps();
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await callHandler({ type: "chat", message: "is payments-api healthy?" }, send as any, deps);

    const streamEnd = messages.find((m: any) => m.type === "chat:stream_end");
    expect(streamEnd).toBeDefined();
    if (streamEnd && (streamEnd as any).type === "chat:stream_end") {
      expect((streamEnd as any).serviceContext).toBe("payments-api");
    }
  });

  it("short-circuits the chat path when no MCP providers are reachable", async () => {
    // Regression: pre-fix, "0 tools" providers wore a green dot and the
    // chat agent ran with an empty tools record, so the LLM produced a
    // useless "We need to run a log query" placeholder. Now we detect
    // the empty fleet first, post a clear error, and burn no tokens.
    const deps = mockDeps();
    const ctx = mockCtx();
    (ctx.providerRegistry.getAll as ReturnType<typeof vi.fn>).mockReturnValue([
      { config: { name: "grafana-mcp" }, source: "config", status: "error", toolCount: 0, enabledToolCount: 0, error: "MCP server returned no tools" },
    ]);

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);
    clearStackCaches(S);
    (createMastraAdapters as ReturnType<typeof vi.fn>).mockClear();
    (getToolsByRole as ReturnType<typeof vi.fn>).mockClear();
    (deps.router.route as ReturnType<typeof vi.fn>).mockClear();

    await callHandler({ type: "chat", message: "whats the ingestion log rate" }, send as any, deps, ctx);

    const streamEnd = messages.find((m: any) => m.type === "chat:stream_end");
    expect(streamEnd).toBeDefined();
    expect((streamEnd as any).content).toMatch(/can't answer/i);
    expect((streamEnd as any).content).toMatch(/Settings/i);

    // No tokens burned, persisted to DB so it survives reload.
    const usage = messages.find((m: any) => m.type === "chat:usage");
    expect((usage as any)?.inputTokens).toBe(0);
    expect((usage as any)?.outputTokens).toBe(0);
    expect(deps.db.createMessage).toHaveBeenCalledWith(
      S,
      expect.objectContaining({ role: "assistant", content: expect.stringMatching(/can't answer/i) }),
    );
    expect(createMastraAdapters).not.toHaveBeenCalled();
    expect(getToolsByRole).not.toHaveBeenCalled();
    expect(deps.router.route).not.toHaveBeenCalled();
  });

  it("short-circuits the chat path when providers are connected but no tools are enabled", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();
    (ctx.providerRegistry.getAll as ReturnType<typeof vi.fn>).mockReturnValue([
      { config: { name: "grafana-mcp" }, source: "config", status: "connected", toolCount: 12, enabledToolCount: 0 },
    ]);

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);
    clearStackCaches(S);
    (createMastraAdapters as ReturnType<typeof vi.fn>).mockClear();
    (getToolsByRole as ReturnType<typeof vi.fn>).mockClear();
    (deps.router.route as ReturnType<typeof vi.fn>).mockClear();

    await callHandler({ type: "chat", message: "whats the ingestion log rate" }, send as any, deps, ctx);

    const streamEnd = messages.find((m: any) => m.type === "chat:stream_end");
    expect((streamEnd as any)?.content).toMatch(/can't answer/i);
    expect(createMastraAdapters).not.toHaveBeenCalled();
    expect(getToolsByRole).not.toHaveBeenCalled();
    expect(deps.router.route).not.toHaveBeenCalled();
  });

  it("chat:stream_end omits serviceContext when service is only resolvable from history", async () => {
    // Regression: when a user's previous chat was about service-A but the new
    // message names service-B (which isn't in the registry), we used to fall
    // back to history-resolved service-A and surface a "Run full investigation
    // on service-A" pill. Wrong service: clicking it would dispatch the wrong
    // RCA. The pill must only render for services explicitly in this message.
    const deps = mockDeps();
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (deps.validateLlmServiceMatch as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const ctx = mockCtx();
    // Pretend the conversation memory resolves to "impala" from prior turns.
    (ctx.conversationMemory.get as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: "user", content: "investigate impala" },
      { role: "assistant", content: "Investigation of impala completed." },
    ]);
    (deps.db.listRecentMessages as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: "user", content: "investigate impala" },
    ]);

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await callHandler({ type: "chat", message: "can you check errors in streaming-etl" }, send as any, deps, ctx);

    const streamEnd = messages.find((m: any) => m.type === "chat:stream_end");
    expect(streamEnd).toBeDefined();
    expect((streamEnd as any).serviceContext).toBeUndefined();
  });

  it("cancel_dispatch for unknown id is a no-op (does not throw)", async () => {
    const deps = mockDeps();
    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);
    const pendingDispatches = new Map<string, AbortController>();

    await callHandler(
      { type: "investigation:cancel_dispatch", id: "inv_does_not_exist" },
      send as any,
      deps,
      undefined,
      pendingDispatches,
    );

    // No errors, no chat messages emitted
    expect(messages).toEqual([]);
  });

  it("aborts pending confirm-dispatch investigations when the socket closes", async () => {
    const deps = mockDeps();
    deps.chatDispatchConfirmMs = 50;
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });

    const server = createServer();
    setupWebSocket(server, deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a port");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws?stackId=${S}`);
    const messages: ServerMessage[] = [];
    client.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()) as ServerMessage);
    });

    await new Promise<void>((resolve) => client.on("open", resolve));
    client.send(JSON.stringify({ type: "chat", message: "/investigate payments-api" }));

    await new Promise<void>((resolve) => {
      const check = () => {
        if (messages.some((m) => m.type === "investigation:confirm_dispatch")) resolve();
        else setTimeout(check, 5);
      };
      check();
    });

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 90));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(messages.some((m) => m.type === "investigation:started")).toBe(false);
    expect(deps.db.createInvestigation).not.toHaveBeenCalled();
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

describe("handleClientMessage — rerun", () => {
  it("emits investigation:started with parentInvestigationId so the client can navigate", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();
    const parentId = "inv_parent_123";
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: parentId, service: "payments-api", query: "orig", status: "complete",
    });
    (deps.sharedDedup!.shouldInvestigate as ReturnType<typeof vi.fn>).mockReturnValue({ allowed: true });

    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    await callHandler({ type: "rerun", investigationId: parentId, template: "quick" }, send, deps, ctx);

    const started = sent.find((m) => m.type === "investigation:started");
    expect(started).toBeDefined();
    if (started && started.type === "investigation:started") {
      expect(started.parentInvestigationId).toBe(parentId);
      expect(started.id).not.toBe(parentId);
      expect(started.service).toBe("payments-api");
    }
  });
});

describe("handleClientMessage — investigation event id filter", () => {
  it("tool_call and iteration events carry the investigation id so the client can filter", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();

    // Wire investigate() to invoke the onToolCall and onIteration callbacks the
    // runner passes in. Arg positions match IInvestigationAgent.investigate:
    // (service, initialAnomaly, correlationId, onTokenUsage, userMessage, onToolCall, onPhase, onIteration, ...)
    const adaptersMod = await import("./agents.js");
    (adaptersMod.createMastraAdapters as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      chatAgent: { chat: vi.fn() },
      investigationAgent: {
        investigate: vi.fn().mockImplementation(async (
          _service: unknown,
          _initialAnomaly: unknown,
          _correlationId: unknown,
          _onTokenUsage: unknown,
          _userMessage: unknown,
          onToolCall?: (name: string, args: Record<string, unknown>, result?: string, durationMs?: number, error?: string, phase?: string) => void,
          _onPhase?: unknown,
          onIteration?: (phase: string, iteration: number, maxIterations: number, description: string) => void,
        ) => {
          onToolCall?.("query_prometheus", { q: "up" }, "ok", 12, undefined, "metrics");
          onIteration?.("metrics", 0, 10, "starting");
          return {
            service: "payments-api", severity: "low", summary: "ok",
            rootCause: "n/a", confidence: "low", trigger: "",
            impact: { duration: "", description: "" },
            contributingFactors: [], timeline: [],
            evidence: { metrics: [], logs: [], infra: [] },
            dashboardLinks: [],
            recommendedActions: [], investigatedAt: new Date().toISOString(),
          };
        }),
      },
      discoverAgent: undefined,
    });

    (deps.router.route as ReturnType<typeof vi.fn>).mockResolvedValue({ intent: "investigation", service: "payments-api" });
    (deps.validateLlmServiceMatch as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });

    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    await callHandler({ type: "chat", message: "investigate payments-api" }, send, deps, ctx);

    const started = sent.find((m) => m.type === "investigation:started");
    const toolCall = sent.find((m) => m.type === "investigation:tool_call");
    const iteration = sent.find((m) => m.type === "investigation:iteration");
    expect(started?.type === "investigation:started" ? started.id : undefined).toBeDefined();
    if (started?.type === "investigation:started" && toolCall?.type === "investigation:tool_call") {
      expect(toolCall.id).toBe(started.id);
    }
    if (started?.type === "investigation:started" && iteration?.type === "investigation:iteration") {
      expect(iteration.id).toBe(started.id);
    }
  });
});

describe("handleClientMessage — scan:trigger", () => {
  it("calls scheduler.triggerNow and forwards events to the connection", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();

    let listener: ((evt: unknown) => void) | null = null;
    const setEventListener = vi.fn((fn: ((evt: unknown) => void) | null) => { listener = fn; });
    const triggerNow = vi.fn(async (_trigger: string) => {
      // Simulate scheduler emitting a scan event while the listener is bound
      listener?.({ type: "scan:started", runId: "r1", stackId: S, trigger: "manual", startedAt: Date.now() });
    });
    (ctx as any).scanScheduler = { setEventListener, triggerNow };

    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    await callHandler({ type: "scan:trigger" }, send, deps, ctx);

    expect(triggerNow).toHaveBeenCalledWith("manual");
    // Listener bound during the call, cleared in finally
    expect(setEventListener).toHaveBeenCalledTimes(2);
    expect(setEventListener.mock.calls[1]![0]).toBeNull();
    // The emitted scan event was forwarded through send()
    expect(sent.some((m) => m.type === "scan:started")).toBe(true);
  });

  it("sends an error when scheduler is unavailable", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();
    (ctx as any).scanScheduler = null;

    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    await callHandler({ type: "scan:trigger" }, send, deps, ctx);

    const err = sent.find((m) => m.type === "error");
    expect(err).toBeDefined();
    if (err && err.type === "error") {
      expect(err.message).toMatch(/scan scheduler/i);
    }
  });
});

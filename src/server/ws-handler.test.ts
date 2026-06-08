import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import WebSocket from "ws";
import { clearStackCaches, handleClientMessage, makeOrchestratorPersistingSend, setupWebSocket } from "./ws-handler.js";
import { OrchestratorRunRegistry } from "./orchestrator-run-registry.js";
import type { WsDeps } from "./ws-handler.js";
import type { Database } from "./db.js";
import type { ServerMessage } from "../types/ws-types.js";
import { DEEP_INVESTIGATION_EVENT_SCHEMA } from "../types/ws-types.js";
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
      getEvents: vi.fn(() => []),
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
    // A zero-length window (test default) skips the confirm-dispatch banner
    // entirely and dispatches straight away — no useless zero-duration flash.
    expect(messages.some((m: any) => m.type === "investigation:confirm_dispatch")).toBe(false);
  });

  it("immediate flag skips the router AND the confirm-dispatch window, dispatching at once", async () => {
    const deps = mockDeps();
    // Give a non-zero window: a typed chat would show the banner, but `immediate`
    // must bypass it regardless of the configured window.
    deps.chatDispatchConfirmMs = 5000;
    (deps.matchServiceFromText as ReturnType<typeof vi.fn>).mockReturnValue({ name: "payments-api", metrics: [], logLabels: {} });

    const messages: unknown[] = [];
    const send = (msg: unknown) => messages.push(msg);

    await callHandler(
      { type: "chat", message: "investigate payments-api", serviceContext: "payments-api", immediate: true },
      send as any,
      deps,
    );

    // Explicit intent — the LLM router is never consulted
    expect(deps.router.route).not.toHaveBeenCalled();
    // No countdown banner emitted
    expect(messages.some((m: any) => m.type === "investigation:confirm_dispatch")).toBe(false);
    // Runner kicked off right away
    expect(messages.some((m: any) => m.type === "investigation:started")).toBe(true);
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

  it("emits discovery phase timing even when validation has no token usage", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();
    clearStackCaches(S);
    const discover = vi.fn(async (
      _config: unknown,
      options?: {
        onPhase?: (phase: string) => void;
        onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
      },
    ) => {
      options?.onPhase?.("discovery");
      options?.onTokenUsage?.({ inputTokens: 10, outputTokens: 5 });
      options?.onPhase?.("validation");
      return {
        services: [{ name: "svc", metrics: [], logLabels: {}, confidence: "verified", validationNotes: "ok" }],
        globalProbeRules: [],
      };
    });
    (createMastraAdapters as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      chatAgent: { chat: vi.fn() },
      investigationAgent: { investigate: vi.fn() },
      discoverAgent: { discover, accept: vi.fn() },
    });

    const sent: ServerMessage[] = [];
    await callHandler({ type: "discover" }, (m) => sent.push(m), deps, ctx);

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "discover:phase_timing", phase: "discovery" }),
      expect.objectContaining({ type: "discover:phase_usage", phase: "discovery", inputTokens: 10, outputTokens: 5 }),
      expect.objectContaining({ type: "discover:phase_timing", phase: "validation" }),
      expect.objectContaining({ type: "discover:phase", phase: "validation", status: "complete" }),
      expect.objectContaining({ type: "discover:complete" }),
    ]));
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

describe("handleClientMessage — orchestrator_investigate", () => {
  it("rejects when the orchestrator gate is disabled", async () => {
    const deps = mockDeps();
    const ctx = mockCtx();
    // Default mockDeps config has no agent.orchestratorEnabled flag.
    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    await callHandler(
      { type: "orchestrator_investigate", investigationId: "inv_1" },
      send, deps, ctx,
    );

    const err = sent.find((m) => m.type === "orchestrator:error");
    expect(err).toBeDefined();
    expect((err as any).message).toContain("not enabled");
    expect(deps.db.getInvestigation).not.toHaveBeenCalled();
  });

  it("returns error for a non-existent investigation when gated on", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    const ctx = mockCtx();
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    await callHandler(
      { type: "orchestrator_investigate", investigationId: "inv_missing" },
      send, deps, ctx,
    );

    const err = sent.find((m) => m.type === "orchestrator:error");
    expect(err).toBeDefined();
    expect((err as any).message).toContain("not found");
  });

  it("rejects a still-running investigation — no autonomous run without a completed report", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    const ctx = mockCtx();
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_running", service: "payments-api", query: "orig", status: "running", report: null,
    });

    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    await callHandler(
      { type: "orchestrator_investigate", investigationId: "inv_running" },
      send, deps, ctx,
    );

    const err = sent.find((m) => m.type === "orchestrator:error");
    expect(err).toBeDefined();
    expect((err as any).message).toContain("completed investigation");
  });

  it("rejects a completed-but-report-less investigation", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    const ctx = mockCtx();
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_noreport", service: "payments-api", query: "orig", status: "complete", report: null,
    });

    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);

    await callHandler(
      { type: "orchestrator_investigate", investigationId: "inv_noreport" },
      send, deps, ctx,
    );

    const err = sent.find((m) => m.type === "orchestrator:error");
    expect(err).toBeDefined();
    expect((err as any).message).toContain("completed investigation");
  });
});

describe("handleClientMessage — orchestrator_accept (PR-6b)", () => {
  // Build a persisted orchestrator event row as getEvents would return it.
  let evtSeq = 0;
  const completeEvent = (outcome: string, causalChain?: unknown[], id?: string) => ({
    id: id ?? `evt_complete_${evtSeq++}`,
    investigation_id: "inv_1",
    event_type: "orchestrator:complete",
    created_at: "2026-06-08T00:00:00Z",
    payload: JSON.stringify({
      schemaVersion: DEEP_INVESTIGATION_EVENT_SCHEMA,
      message: { type: "orchestrator:complete", investigationId: "inv_1", outcome, causalChain },
    }),
  });
  const confirmedChain = [
    { label: "payments-api", kind: "incident" },
    { label: "payments-db", kind: "followed", evidence: "connection saturation" },
    { label: "root cause: connection pool exhaustion", kind: "root-cause", evidence: "pool_used = 100%" },
  ];
  const baseReport = {
    service: "payments-api", rootCause: "timeout in payments-api",
    confidence: "medium", confidenceScore: 0.5,
  };

  it("rejects when the orchestrator gate is disabled", async () => {
    const deps = mockDeps();
    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);
    const rej = sent.find((m) => m.type === "orchestrator:accept_rejected");
    expect(rej).toBeDefined();
    expect((rej as any).message).toContain("not enabled");
    expect(deps.db.getInvestigation).not.toHaveBeenCalled();
  });

  it("merges the confirmed root cause into the report, preserves the original, and persists", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: JSON.stringify(baseReport),
    });
    (deps.db.getEvents as ReturnType<typeof vi.fn>).mockReturnValue([completeEvent("confirmed", confirmedChain)]);

    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);

    // Persisted refined report
    expect(deps.db.updateInvestigation).toHaveBeenCalledTimes(1);
    const writeArg = (deps.db.updateInvestigation as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const persisted = JSON.parse(writeArg.report);
    expect(persisted.rootCause).toBe("connection pool exhaustion"); // stripped "root cause: " prefix
    expect(persisted.confidence).toBe("high");
    expect(persisted.orchestratorRefined.originalRootCause).toBe("timeout in payments-api");
    expect(persisted.orchestratorRefined.outcome).toBe("confirmed");
    expect(persisted.orchestratorRefined.causalChain).toHaveLength(3);

    // Echoed back to the client
    const acc = sent.find((m) => m.type === "orchestrator:accepted");
    expect(acc).toBeDefined();
    expect((acc as any).report.rootCause).toBe("connection pool exhaustion");
  });

  it("carries the operator's pause steer onto the refinement marker", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: JSON.stringify(baseReport),
    });
    (deps.db.getEvents as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "evt_lock_1", investigation_id: "inv_1", created_at: "2026-06-08T00:00:00Z",
        event_type: "orchestrator:decision_locked", payload: JSON.stringify({
        schemaVersion: DEEP_INVESTIGATION_EVENT_SCHEMA,
        message: { type: "orchestrator:decision_locked", investigationId: "inv_1", context: "check the DB pool config" },
      }) },
      completeEvent("confirmed", confirmedChain),
    ]);

    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);
    const writeArg = (deps.db.updateInvestigation as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(JSON.parse(writeArg.report).orchestratorRefined.operatorNotes).toBe("check the DB pool config");
  });

  it("does NOT attribute a steer from an earlier run that locked then errored without completing", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: JSON.stringify(baseReport),
    });
    const row = (event_type: string, message: unknown, idn: number) => ({
      id: `evt_${idn}`, investigation_id: "inv_1", created_at: "2026-06-08T00:00:00Z",
      event_type, payload: JSON.stringify({ schemaVersion: DEEP_INVESTIGATION_EVENT_SCHEMA, message }),
    });
    (deps.db.getEvents as ReturnType<typeof vi.fn>).mockReturnValue([
      // Run A: started → operator steered → errored (NO complete).
      row("orchestrator:started", { type: "orchestrator:started", investigationId: "inv_1" }, 1),
      row("orchestrator:decision_locked", { type: "orchestrator:decision_locked", investigationId: "inv_1", context: "run A steer — must NOT leak" }, 2),
      row("orchestrator:error", { type: "orchestrator:error", investigationId: "inv_1", message: "boom" }, 3),
      // Run B: started → completed confirmed, with no steer of its own.
      row("orchestrator:started", { type: "orchestrator:started", investigationId: "inv_1" }, 4),
      completeEvent("confirmed", confirmedChain, "evt_runB"),
    ]);

    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, vi.fn(), deps);
    const persisted = JSON.parse((deps.db.updateInvestigation as ReturnType<typeof vi.fn>).mock.calls[0]![1].report);
    expect(persisted.orchestratorRefined.operatorNotes).toBeUndefined();
  });

  it("rejects while a deep run is still live (don't apply a soon-to-be-superseded result)", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    const registry = new OrchestratorRunRegistry();
    vi.spyOn(registry, "isLive").mockReturnValue(true);

    const sent: ServerMessage[] = [];
    await handleClientMessage(
      { type: "orchestrator_accept", investigationId: "inv_1" },
      (m) => sent.push(m), deps, `stack_${S}_web_test`, S, mockCtx(),
      () => null, () => {}, () => {},
      new Map(), { current: null }, registry,
    );

    expect(deps.db.getInvestigation).not.toHaveBeenCalled();
    expect(deps.db.updateInvestigation).not.toHaveBeenCalled();
    const rej = sent.find((m) => m.type === "orchestrator:accept_rejected");
    expect((rej as any).message).toContain("still running");
  });

  it("rejects when there is no completed orchestrator event", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: JSON.stringify(baseReport),
    });
    (deps.db.getEvents as ReturnType<typeof vi.fn>).mockReturnValue([]); // no complete event

    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);
    expect(deps.db.updateInvestigation).not.toHaveBeenCalled();
    expect(sent.find((m) => m.type === "orchestrator:accept_rejected")).toBeDefined();
  });

  it("rejects when the run outcome is not confirmed", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: JSON.stringify(baseReport),
    });
    (deps.db.getEvents as ReturnType<typeof vi.fn>).mockReturnValue([completeEvent("inconclusive", confirmedChain)]);

    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);
    expect(deps.db.updateInvestigation).not.toHaveBeenCalled();
    const rej = sent.find((m) => m.type === "orchestrator:accept_rejected");
    expect((rej as any).message).toContain("didn't confirm");
  });

  it("rejects when the report is missing", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: null,
    });

    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);
    expect(deps.db.updateInvestigation).not.toHaveBeenCalled();
    expect(sent.find((m) => m.type === "orchestrator:accept_rejected")).toBeDefined();
  });

  it("rejects a malformed report JSON", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: "{not json",
    });

    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);
    expect(deps.db.updateInvestigation).not.toHaveBeenCalled();
    const rej = sent.find((m) => m.type === "orchestrator:accept_rejected");
    expect((rej as any).message).toContain("parse");
  });

  it("rejects when the confirmed chain has no root-cause link", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: JSON.stringify(baseReport),
    });
    (deps.db.getEvents as ReturnType<typeof vi.fn>).mockReturnValue([
      completeEvent("confirmed", [{ label: "payments-api", kind: "incident" }]),
    ]);

    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);
    expect(deps.db.updateInvestigation).not.toHaveBeenCalled();
    const rej = sent.find((m) => m.type === "orchestrator:accept_rejected");
    expect((rej as any).message).toContain("root cause");
  });

  it("uses the LATEST complete event when several are persisted", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: JSON.stringify(baseReport),
    });
    const olderChain = [{ label: "root cause: stale conclusion", kind: "root-cause" }];
    (deps.db.getEvents as ReturnType<typeof vi.fn>).mockReturnValue([
      completeEvent("confirmed", olderChain),
      completeEvent("confirmed", confirmedChain),
    ]);

    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);
    const writeArg = (deps.db.updateInvestigation as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(JSON.parse(writeArg.report).rootCause).toBe("connection pool exhaustion");
  });

  it("re-applying the SAME complete event preserves the TRUE original (idempotent audit trail)", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    // Already refined from event "evt_runA"; rootCause is that refined value.
    const alreadyRefined = {
      ...baseReport,
      rootCause: "connection pool exhaustion",
      orchestratorRefined: { outcome: "confirmed", causalChain: [], refinedAt: "2026-06-08T00:00:00Z", originalRootCause: "timeout in payments-api", appliedCompleteEventId: "evt_runA" },
    };
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: JSON.stringify(alreadyRefined),
    });
    // Re-applying the SAME run (same event id) — idempotent retry.
    (deps.db.getEvents as ReturnType<typeof vi.fn>).mockReturnValue([completeEvent("confirmed", confirmedChain, "evt_runA")]);

    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);
    const writeArg = (deps.db.updateInvestigation as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    // NOT clobbered with the already-refined rootCause — the real original survives.
    expect(JSON.parse(writeArg.report).orchestratorRefined.originalRootCause).toBe("timeout in payments-api");
  });

  it("applying a NEW deep run uses the report's CURRENT root cause as the 'was' (audit trail advances)", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    // Already refined from run A → rootCause is causeA.
    const refinedFromA = {
      ...baseReport,
      rootCause: "connection pool exhaustion",
      orchestratorRefined: { outcome: "confirmed", causalChain: [], refinedAt: "2026-06-08T00:00:00Z", originalRootCause: "timeout in payments-api", appliedCompleteEventId: "evt_runA" },
    };
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: JSON.stringify(refinedFromA),
    });
    // A genuinely NEW deep run (evt_runB) confirmed a DIFFERENT cause.
    const runBChain = [
      { label: "payments-api", kind: "incident" },
      { label: "root cause: disk saturation on payments-db", kind: "root-cause" },
    ];
    (deps.db.getEvents as ReturnType<typeof vi.fn>).mockReturnValue([
      completeEvent("confirmed", confirmedChain, "evt_runA"),
      completeEvent("confirmed", runBChain, "evt_runB"),
    ]);

    const sent: ServerMessage[] = [];
    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, (m) => sent.push(m), deps);
    const persisted = JSON.parse((deps.db.updateInvestigation as ReturnType<typeof vi.fn>).mock.calls[0]![1].report);
    expect(persisted.rootCause).toBe("disk saturation on payments-db");
    // "was" is what the report said right before THIS apply (causeA), not the first original.
    expect(persisted.orchestratorRefined.originalRootCause).toBe("connection pool exhaustion");
    expect(persisted.orchestratorRefined.appliedCompleteEventId).toBe("evt_runB");
  });

  it("persists the orchestrator:accepted event so cold clients converge", async () => {
    const deps = mockDeps();
    (deps.config as any).agent.orchestratorEnabled = true;
    (deps.db.getInvestigation as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "inv_1", service: "payments-api", status: "complete", report: JSON.stringify(baseReport),
    });
    (deps.db.getEvents as ReturnType<typeof vi.fn>).mockReturnValue([completeEvent("confirmed", confirmedChain)]);

    await callHandler({ type: "orchestrator_accept", investigationId: "inv_1" }, vi.fn(), deps);
    const acceptedPersist = (deps.db.createEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((e: any) => e.eventType === "orchestrator:accepted");
    expect(acceptedPersist).toBeDefined();
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

describe("handleClientMessage — discovery skill injection", () => {
  function discoverAdapters(discover: ReturnType<typeof vi.fn>) {
    return {
      chatAgent: { chat: vi.fn() },
      investigationAgent: { investigate: vi.fn() },
      discoverAgent: {
        discover,
        accept: vi.fn(),
      },
    };
  }

  const consulSkill = {
    id: "consul-bare-metal",
    title: "Consul Bare Metal",
    services: [],
    alerts: [],
    tags: [],
    scope: ["discovery"],
    filePath: "consul-bare-metal.md",
    body: "```promql\ncount by (service_name) (consul_health_service_status)\n```",
  };

  it("injects stack-enabled discovery-scoped skills by default", async () => {
    clearStackCaches(S);
    const deps = mockDeps();
    deps.skillStore = {
      getById: vi.fn((id: string) => id === consulSkill.id ? consulSkill : undefined),
      getAllForScopeEnabled: vi.fn(() => [consulSkill]),
    } as any;
    const discover = vi.fn().mockResolvedValue({ services: [], globalProbeRules: [] });
    (createMastraAdapters as ReturnType<typeof vi.fn>).mockReset();
    (createMastraAdapters as ReturnType<typeof vi.fn>).mockResolvedValue(discoverAdapters(discover));

    const sent: ServerMessage[] = [];
    await callHandler({ type: "discover" }, (m) => sent.push(m), deps);

    expect(discover).toHaveBeenCalled();
    expect(discover.mock.calls[0]![1]).toMatchObject({
      skills: [expect.objectContaining({ id: consulSkill.id })],
    });
  });

  it("supersedes an in-flight discover with a second request and suppresses the first run's events", async () => {
    clearStackCaches(S);
    const deps = mockDeps();
    let firstAbortSignal: AbortSignal | undefined;
    let firstOnPhase: ((p: string) => void) | undefined;
    const discover = vi.fn()
      .mockImplementationOnce(async (_cfg: unknown, opts: any) => {
        firstAbortSignal = opts?.abortSignal;
        firstOnPhase = opts?.onPhase;
        // Hang until aborted (simulating a discovery the user superseded)
        await new Promise<void>((_resolve, reject) => {
          opts?.abortSignal?.addEventListener("abort", () => {
            reject(opts.abortSignal!.reason ?? new Error("aborted"));
          });
        });
        return { services: [], globalProbeRules: [] };
      })
      .mockImplementationOnce(async () => ({
        services: [{ name: "second-run", metrics: [], logLabels: {}, confidence: "verified" as const, validationNotes: "ok" }],
        globalProbeRules: [],
      }));
    (createMastraAdapters as ReturnType<typeof vi.fn>).mockReset();
    (createMastraAdapters as ReturnType<typeof vi.fn>).mockResolvedValue(discoverAdapters(discover));

    const sent: ServerMessage[] = [];
    const send = (m: ServerMessage) => sent.push(m);
    const ctx = mockCtx();
    const activeDiscovery = { current: null as AbortController | null };

    const first = handleClientMessage(
      { type: "discover" } as any, send, deps, `stack_${S}_test`, S, ctx,
      () => null, () => {}, () => {}, new Map(), activeDiscovery,
    );
    // Let the first call enter the agent.discover() await
    await new Promise<void>((r) => setTimeout(r, 5));

    // Fire the second discover. This should abort the first.
    await handleClientMessage(
      { type: "discover" } as any, send, deps, `stack_${S}_test`, S, ctx,
      () => null, () => {}, () => {}, new Map(), activeDiscovery,
    );
    // First run's promise rejects, the catch sees signal.aborted and returns silently
    await first;

    expect(firstAbortSignal?.aborted).toBe(true);
    expect(String(firstAbortSignal?.reason)).toMatch(/superseded/i);
    // First run's onPhase callback fired now should not emit (it would interleave with the second run)
    const sentBefore = sent.length;
    firstOnPhase?.("validation");
    expect(sent.length).toBe(sentBefore);
    // No discover:error from the superseded first run
    expect(sent.some((m) => m.type === "discover:error")).toBe(false);
    // Second run completed normally
    expect(sent.some((m) => m.type === "discover:complete")).toBe(true);
  });

  it("aborts in-flight discovery when the WebSocket closes", async () => {
    clearStackCaches(S);
    const deps = mockDeps();
    let capturedSignal: AbortSignal | undefined;
    const discover = vi.fn(async (_cfg: unknown, opts: any) => {
      capturedSignal = opts?.abortSignal;
      // Hang until aborted
      await new Promise<void>((_resolve, reject) => {
        opts?.abortSignal?.addEventListener("abort", () => {
          reject(opts.abortSignal!.reason ?? new Error("aborted"));
        });
      });
      return { services: [], globalProbeRules: [] };
    });
    (createMastraAdapters as ReturnType<typeof vi.fn>).mockReset();
    (createMastraAdapters as ReturnType<typeof vi.fn>).mockResolvedValue(discoverAdapters(discover));

    const server = createServer();
    setupWebSocket(server, deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a port");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws?stackId=${S}`);
    await new Promise<void>((resolve) => client.on("open", resolve));
    client.send(JSON.stringify({ type: "discover" }));

    // Wait until discover() has been entered
    await new Promise<void>((resolve) => {
      const check = () => {
        if (capturedSignal) resolve();
        else setTimeout(check, 5);
      };
      check();
    });

    client.close();
    // Give the close handler a tick to abort
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(capturedSignal?.aborted).toBe(true);
    expect(String(capturedSignal?.reason)).toMatch(/disconnected/i);
  });

});

// ── PR-2 (T6): persisting-send wrapper ───────────────────────────────────────
describe("makeOrchestratorPersistingSend", () => {
  const ID = "inv_persist_1";
  function mockDb(createEvent = vi.fn()): { db: Database; createEvent: ReturnType<typeof vi.fn> } {
    return { db: { createEvent } as unknown as Database, createEvent };
  }

  it("persists an orchestrator:* event (versioned envelope) AND forwards it", () => {
    const { db, createEvent } = mockDb();
    const send = vi.fn();
    const wrapped = makeOrchestratorPersistingSend(db, ID, send);

    const msg: ServerMessage = { type: "orchestrator:started", investigationId: ID };
    wrapped(msg);

    // forwarded to the live stream unchanged
    expect(send).toHaveBeenCalledWith(msg);
    // persisted once, with the versioned envelope around the raw message
    expect(createEvent).toHaveBeenCalledTimes(1);
    const arg = createEvent.mock.calls[0]![0] as { id: string; investigationId: string; eventType: string; payload: string };
    expect(arg.investigationId).toBe(ID);
    expect(arg.eventType).toBe("orchestrator:started");
    expect(arg.id).toMatch(/^evt_/);
    expect(JSON.parse(arg.payload)).toEqual({ schemaVersion: DEEP_INVESTIGATION_EVENT_SCHEMA, message: msg });
  });

  it("does NOT persist non-orchestrator messages, but still forwards them", () => {
    const { db, createEvent } = mockDb();
    const send = vi.fn();
    const wrapped = makeOrchestratorPersistingSend(db, ID, send);

    wrapped({ type: "deep_mode:started", investigationId: ID } as ServerMessage);
    wrapped({ type: "error", message: "x" } as ServerMessage);

    expect(createEvent).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does NOT persist an orchestrator event for a different investigationId", () => {
    const { db, createEvent } = mockDb();
    const send = vi.fn();
    const wrapped = makeOrchestratorPersistingSend(db, ID, send);

    wrapped({ type: "orchestrator:started", investigationId: "other_inv" } as ServerMessage);

    expect(createEvent).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1); // still forwarded
  });

  it("is throw-safe: a persist failure NEVER breaks the live stream", () => {
    const createEvent = vi.fn(() => { throw new Error("disk full"); });
    const { db } = mockDb(createEvent);
    const send = vi.fn();
    const wrapped = makeOrchestratorPersistingSend(db, ID, send);

    const msg: ServerMessage = { type: "orchestrator:step", investigationId: ID, event: { seq: 0, verb: "x", status: "running" } };
    expect(() => wrapped(msg)).not.toThrow();
    expect(send).toHaveBeenCalledWith(msg); // forwarded despite the persist throw
  });

  // PR-2c: a socket close no longer aborts the run (it detaches), so there is no
  // disconnect-triggered terminal to suppress — every emitted orchestrator event
  // is persisted, including a deliberate Stop's terminal (→ replays as "Stopped").
  it("persists a terminal (e.g. a deliberate Stop's aborted complete) so a reload replays it", () => {
    const { db, createEvent } = mockDb();
    const send = vi.fn();
    const wrapped = makeOrchestratorPersistingSend(db, ID, send);

    wrapped({ type: "orchestrator:step", investigationId: ID, event: { seq: 0, verb: "x", status: "running" } } as ServerMessage);
    wrapped({ type: "orchestrator:complete", investigationId: ID, outcome: "aborted", stats: { moves: 1, toolCalls: 0, subagents: 0, tokensSpent: 0, strikes: 0, depth: 1, durationMs: 5 } } as ServerMessage);

    expect(createEvent).toHaveBeenCalledTimes(2);
    expect(createEvent.mock.calls[1]![0]).toMatchObject({ eventType: "orchestrator:complete" });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

// ── PR-2c (T3): orchestrator_subscribe / _unsubscribe reattach ───────────────
describe("orchestrator_subscribe / _unsubscribe", () => {
  const ID = "inv_sub_1";
  const ROWS = [
    { id: "e1", investigation_id: ID, event_type: "orchestrator:started", payload: JSON.stringify({ schemaVersion: 1, message: { type: "orchestrator:started", investigationId: ID } }), created_at: "2026-06-07T00:00:00Z" },
    { id: "e2", investigation_id: ID, event_type: "orchestrator:step", payload: JSON.stringify({ schemaVersion: 1, message: { type: "orchestrator:step", investigationId: ID, event: { seq: 0, verb: "x", status: "running" } } }), created_at: "2026-06-07T00:00:01Z" },
  ];

  function depsWithEvents(getEvents = vi.fn(() => ROWS)): WsDeps {
    const base = mockDeps();
    (base.db as unknown as { getEvents: unknown }).getEvents = getEvents;
    return base;
  }

  function callSubscribe(msg: unknown, send: (m: ServerMessage) => void, deps: WsDeps, registry: OrchestratorRunRegistry, myRuns: Set<string>) {
    return handleClientMessage(
      msg as never, send, deps, `stack_${S}_web_test`, S, mockCtx(),
      () => null, () => {}, () => {},
      new Map(), { current: null }, registry, myRuns,
    );
  }

  it("subscribe to a LIVE run attaches the sink and replays persisted history one-shot", async () => {
    const reg = new OrchestratorRunRegistry();
    reg.create(ID, new AbortController());
    const myRuns = new Set<string>();
    const sent: ServerMessage[] = [];
    await callSubscribe({ type: "orchestrator_subscribe", investigationId: ID }, (m) => sent.push(m), depsWithEvents(), reg, myRuns);

    expect(reg.sinkCount(ID)).toBe(1);          // attached as a live sink
    expect(myRuns.has(ID)).toBe(true);
    const replay = sent.find((m) => m.type === "orchestrator:replay") as Extract<ServerMessage, { type: "orchestrator:replay" }>;
    expect(replay).toBeTruthy();
    expect(replay.live).toBe(true);
    expect(replay.events).toHaveLength(2);       // the persisted rows
    expect(replay.events[0]!.event_type).toBe("orchestrator:started");
    // subsequent live broadcasts now reach the subscribed sink
    reg.broadcast(ID, { type: "orchestrator:step", investigationId: ID, event: { seq: 1, verb: "y", status: "running" } });
    expect(sent.some((m) => m.type === "orchestrator:step")).toBe(true);
  });

  it("subscribe to a NON-LIVE run answers orchestrator:not_live (client uses cold render)", async () => {
    const reg = new OrchestratorRunRegistry();
    const sent: ServerMessage[] = [];
    await callSubscribe({ type: "orchestrator_subscribe", investigationId: "inv_absent" }, (m) => sent.push(m), depsWithEvents(), reg, new Set());
    expect(sent).toEqual([{ type: "orchestrator:not_live", investigationId: "inv_absent" }]);
  });

  it("subscribe to a PARKED run wakes it (status running, park pause resolved)", async () => {
    const reg = new OrchestratorRunRegistry();
    reg.create(ID, new AbortController());
    reg.markParked(ID);
    const parkResolve = vi.fn();
    reg.setPause(ID, { resolve: parkResolve, timer: null, kind: "park" });
    await callSubscribe({ type: "orchestrator_subscribe", investigationId: ID }, vi.fn(), depsWithEvents(), reg, new Set());
    expect(reg.status(ID)).toBe("running");
    expect(parkResolve).toHaveBeenCalledWith("continue", undefined);
  });

  it("unsubscribe detaches this connection's sink", async () => {
    const reg = new OrchestratorRunRegistry();
    reg.create(ID, new AbortController());
    const send = vi.fn();
    const myRuns = new Set<string>();
    await callSubscribe({ type: "orchestrator_subscribe", investigationId: ID }, send, depsWithEvents(), reg, myRuns);
    expect(reg.sinkCount(ID)).toBe(1);
    await callSubscribe({ type: "orchestrator_unsubscribe", investigationId: ID }, send, depsWithEvents(), reg, myRuns);
    expect(reg.sinkCount(ID)).toBe(0);
    expect(myRuns.has(ID)).toBe(false);
  });

  it("replay is resilient to a getEvents failure (sends empty history, still attaches)", async () => {
    const reg = new OrchestratorRunRegistry();
    reg.create(ID, new AbortController());
    const sent: ServerMessage[] = [];
    const throwing = vi.fn(() => { throw new Error("db down"); });
    await callSubscribe({ type: "orchestrator_subscribe", investigationId: ID }, (m) => sent.push(m), depsWithEvents(throwing), reg, new Set());
    const replay = sent.find((m) => m.type === "orchestrator:replay") as Extract<ServerMessage, { type: "orchestrator:replay" }>;
    expect(replay.events).toEqual([]);
    expect(reg.sinkCount(ID)).toBe(1);
  });

  // T6: the first decision at a pause wins and locks every attached tab; a second
  // decision from another tab is ignored (cross-tab D7 via the registry lock).
  it("first decision resolves + broadcasts decision_locked to all tabs; a second is ignored", async () => {
    const reg = new OrchestratorRunRegistry();
    reg.create(ID, new AbortController());
    const resolve = vi.fn();
    reg.setPause(ID, { resolve, timer: null, kind: "operator" });
    const tabA: ServerMessage[] = []; const tabB: ServerMessage[] = [];
    reg.attachSink(ID, (m) => tabA.push(m));
    reg.attachSink(ID, (m) => tabB.push(m));

    await callSubscribe({ type: "orchestrator_decision", investigationId: ID, decision: "escalate" }, vi.fn(), depsWithEvents(), reg, new Set());
    expect(resolve).toHaveBeenCalledWith("escalate", undefined);
    expect(tabA.some((m) => m.type === "orchestrator:decision_locked")).toBe(true);
    expect(tabB.some((m) => m.type === "orchestrator:decision_locked")).toBe(true);

    // a second tab's decision finds the lock closed + no pause → no-op
    resolve.mockClear();
    await callSubscribe({ type: "orchestrator_decision", investigationId: ID, decision: "continue" }, vi.fn(), depsWithEvents(), reg, new Set());
    expect(resolve).not.toHaveBeenCalled();
  });

  it("a decision PERSISTS decision_locked so a tab reattaching before the next step replays the lock", async () => {
    const reg = new OrchestratorRunRegistry();
    reg.create(ID, new AbortController());
    reg.setPause(ID, { resolve: vi.fn(), timer: null, kind: "operator" });
    const deps = depsWithEvents();
    await callSubscribe({ type: "orchestrator_decision", investigationId: ID, decision: "escalate" }, vi.fn(), deps, reg, new Set());
    const createEvent = deps.db.createEvent as ReturnType<typeof vi.fn>;
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "orchestrator:decision_locked" }));
  });

  it("a continue-with-context forwards the lead to resolvePause and persists it on decision_locked (PR-4)", async () => {
    const reg = new OrchestratorRunRegistry();
    reg.create(ID, new AbortController());
    const resolve = vi.fn();
    reg.setPause(ID, { resolve, timer: null, kind: "operator" });
    const tab: ServerMessage[] = [];
    reg.attachSink(ID, (m) => tab.push(m));
    const deps = depsWithEvents();

    await callSubscribe(
      { type: "orchestrator_decision", investigationId: ID, decision: "continue", context: "  check the DB pool  " },
      vi.fn(), deps, reg, new Set(),
    );

    // lead is trimmed and forwarded to the loop
    expect(resolve).toHaveBeenCalledWith("continue", "check the DB pool");
    // and persisted/broadcast on the lock so reattaching tabs + cold replays show it
    const locked = tab.find((m) => m.type === "orchestrator:decision_locked");
    expect(locked).toMatchObject({ context: "check the DB pool" });
    const createEvent = deps.db.createEvent as ReturnType<typeof vi.fn>;
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "orchestrator:decision_locked", payload: expect.stringContaining("check the DB pool") }),
    );
  });

  it("a non-continue decision drops any context (escalate/wait stop the run) (PR-4)", async () => {
    const reg = new OrchestratorRunRegistry();
    reg.create(ID, new AbortController());
    const resolve = vi.fn();
    reg.setPause(ID, { resolve, timer: null, kind: "operator" });
    await callSubscribe(
      { type: "orchestrator_decision", investigationId: ID, decision: "escalate", context: "ignored" },
      vi.fn(), depsWithEvents(), reg, new Set(),
    );
    expect(resolve).toHaveBeenCalledWith("escalate", undefined);
  });

  it("a malformed non-string context does not throw or wedge the pause (PR-4, codex P2)", async () => {
    const reg = new OrchestratorRunRegistry();
    reg.create(ID, new AbortController());
    const resolve = vi.fn();
    reg.setPause(ID, { resolve, timer: null, kind: "operator" });
    // A stale/direct WS client sends a non-string context; must not throw after the
    // lock, must resolve the pause (lead coerced to undefined).
    await callSubscribe(
      { type: "orchestrator_decision", investigationId: ID, decision: "continue", context: {} as unknown as string },
      vi.fn(), depsWithEvents(), reg, new Set(),
    );
    expect(resolve).toHaveBeenCalledWith("continue", undefined);
    expect(reg.hasPause(ID)).toBe(false);
  });
});

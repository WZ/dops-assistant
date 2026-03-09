import { describe, it, expect, vi } from "vitest";
import { handleClientMessage } from "./ws-handler.js";
import type { WsDeps } from "./ws-handler.js";

function mockDeps(): WsDeps {
  return {
    db: {
      createInvestigation: vi.fn(),
      updateInvestigation: vi.fn(),
      createPhase: vi.fn(),
      updatePhase: vi.fn(),
      createMessage: vi.fn(),
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

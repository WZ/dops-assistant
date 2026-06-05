// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ServerMessage, ClientMessage, AgentStreamEvent } from "../../types/ws-types.js";
import {
  applyMessage,
  OrchestratorRunProvider,
  useOrchestratorRun,
  useOrchestratorRunActions,
  type DeepRunState,
} from "./OrchestratorRunContext";

const ID = "inv_1";
const step = (seq: number): AgentStreamEvent => ({ seq, verb: "testing", status: "running" });
const empty = (): ReadonlyMap<string, DeepRunState> => new Map();

// ── pure reducer: every orchestrator:* + deep_mode:* transition ──────────────
describe("applyMessage — reducer transitions", () => {
  it("orchestrator: started → step → operator_pause → step (resume) → complete", () => {
    let m = applyMessage(empty(), { type: "orchestrator:started", investigationId: ID });
    expect(m.get(ID)).toMatchObject({ kind: "orchestrator", running: true, steps: [], error: null });

    m = applyMessage(m, { type: "orchestrator:step", investigationId: ID, event: step(0) });
    expect(m.get(ID)!.steps).toHaveLength(1);

    m = applyMessage(m, { type: "orchestrator:operator_pause", investigationId: ID, strikes: 3, hypothesesTried: ["a", "b"] });
    expect(m.get(ID)!.pause).toEqual({ strikes: 3, hypothesesTried: ["a", "b"] });
    expect(m.get(ID)!.decisionSubmitted).toBe(false);

    // a new step means the loop resumed — pause + submit-lock clear
    m = applyMessage(m, { type: "orchestrator:step", investigationId: ID, event: step(1) });
    expect(m.get(ID)!.pause).toBeNull();
    expect(m.get(ID)!.decisionSubmitted).toBe(false);
    expect(m.get(ID)!.steps).toHaveLength(2);

    m = applyMessage(m, {
      type: "orchestrator:complete",
      investigationId: ID,
      outcome: "confirmed",
      stats: { moves: 5, toolCalls: 2, subagents: 1, tokensSpent: 100, strikes: 0, depth: 1, durationMs: 1234 },
      causalChain: [{ label: "svc", kind: "incident" }],
      traceSummary: "5 moves · confirmed at depth 1",
    });
    const run = m.get(ID)!;
    expect(run.running).toBe(false);
    expect(run.outcome).toBe("confirmed");
    expect(run.causalChain).toHaveLength(1);
    expect(run.pause).toBeNull();
  });

  it("orchestrator:error stops the run and records the message", () => {
    let m = applyMessage(empty(), { type: "orchestrator:started", investigationId: ID });
    m = applyMessage(m, { type: "orchestrator:error", investigationId: ID, message: "boom" });
    expect(m.get(ID)).toMatchObject({ running: false, error: "boom", pause: null });
  });

  it("deep-mode: started → step → complete carries the report + stats", () => {
    let m = applyMessage(empty(), { type: "deep_mode:started", investigationId: ID });
    expect(m.get(ID)).toMatchObject({ kind: "deep-mode", running: true });
    m = applyMessage(m, { type: "deep_mode:step", investigationId: ID, event: step(0) });
    m = applyMessage(m, {
      type: "deep_mode:complete",
      investigationId: ID,
      report: { summary: "x" },
      stats: { examined: 3, toolCalls: 1, resurrected: 0, shaken: 1, durationMs: 50 },
    });
    expect(m.get(ID)).toMatchObject({ running: false, report: { summary: "x" } });
    expect(m.get(ID)!.deepStats?.examined).toBe(3);
  });

  it("ignores messages for unstarted runs and unrelated message types", () => {
    // step before started → no-op (same map identity)
    const m0 = empty();
    expect(applyMessage(m0, { type: "orchestrator:step", investigationId: ID, event: step(0) })).toBe(m0);
    // a message we don't own → passthrough
    expect(applyMessage(m0, { type: "session_cleared" } as ServerMessage)).toBe(m0);
  });

  it("isolates state per investigationId", () => {
    let m = applyMessage(empty(), { type: "orchestrator:started", investigationId: "a" });
    m = applyMessage(m, { type: "deep_mode:started", investigationId: "b" });
    m = applyMessage(m, { type: "orchestrator:step", investigationId: "a", event: step(0) });
    expect(m.get("a")!.steps).toHaveLength(1);
    expect(m.get("b")!.steps).toHaveLength(0);
    expect(m.get("b")!.kind).toBe("deep-mode");
  });
});

// ── provider: WS processing + command helpers + D7 locking ───────────────────
function makeWrapper(messagesRef: { current: ServerMessage[] }, send: (m: ClientMessage) => void, status: "connecting" | "connected" | "disconnected" = "connected") {
  return ({ children }: { children: ReactNode }) => (
    <OrchestratorRunProvider wsMessages={messagesRef.current} wsSend={send} connectionStatus={status}>
      {children}
    </OrchestratorRunProvider>
  );
}

describe("OrchestratorRunProvider", () => {
  it("processes appended WS messages into the registry once", () => {
    const send = vi.fn();
    // Mirror real useWebSocket: every message yields a NEW array identity.
    const ref = { current: [] as ServerMessage[] };
    const { result, rerender } = renderHook(() => useOrchestratorRun(ID), { wrapper: makeWrapper(ref, send) });
    expect(result.current).toBeUndefined();

    act(() => { ref.current = [...ref.current, { type: "orchestrator:started", investigationId: ID }]; });
    rerender();
    expect(result.current?.running).toBe(true);

    act(() => { ref.current = [...ref.current, { type: "orchestrator:step", investigationId: ID, event: step(0) }]; });
    rerender();
    expect(result.current?.steps).toHaveLength(1);
  });

  it("start() sends the right client message per scope", () => {
    const send = vi.fn();
    const ref = { current: [] as ServerMessage[] };
    const { result } = renderHook(() => useOrchestratorRunActions(), { wrapper: makeWrapper(ref, send) });
    act(() => result.current.start(ID, "challenge"));
    expect(send).toHaveBeenCalledWith({ type: "deep_mode_investigate", investigationId: ID });
    act(() => result.current.start(ID, "full"));
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_investigate", investigationId: ID });
  });

  it("decide() locks after the first submit (D7) — a second click is ignored", () => {
    const send = vi.fn();
    const messages: ServerMessage[] = [
      { type: "orchestrator:started", investigationId: ID },
      { type: "orchestrator:operator_pause", investigationId: ID, strikes: 3 },
    ];
    const ref = { current: messages };
    const { result } = renderHook(
      () => ({ run: useOrchestratorRun(ID), actions: useOrchestratorRunActions() }),
      { wrapper: makeWrapper(ref, send) },
    );
    expect(result.current.run?.pause).toBeTruthy();

    act(() => result.current.actions.decide(ID, "escalate"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.run?.decisionSubmitted).toBe(true);
    expect(result.current.run?.disposition).toBe("escalate");

    // second click (e.g. from the other surface) is a no-op
    act(() => result.current.actions.decide(ID, "wait"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("setCollapsed() toggles the inline region flag", () => {
    const send = vi.fn();
    const ref = { current: [{ type: "orchestrator:started", investigationId: ID }] as ServerMessage[] };
    const { result } = renderHook(
      () => ({ run: useOrchestratorRun(ID), actions: useOrchestratorRunActions() }),
      { wrapper: makeWrapper(ref, send) },
    );
    expect(result.current.run?.collapsed).toBe(false);
    act(() => result.current.actions.setCollapsed(ID, true));
    expect(result.current.run?.collapsed).toBe(true);
  });

  it("does not replay a compacted (trimmed) WS buffer onto run state", () => {
    // useWebSocket compacts at 2000 messages by slicing to the last 1500 — the
    // array shrinks but keeps already-processed messages (incl. a *:started).
    // Treating that as a stack-switch reset would replay them: duplicate steps,
    // or reset the run on the retained started. (Codex review of #234.)
    const send = vi.fn();
    const ref = { current: [] as ServerMessage[] };
    const { result, rerender } = renderHook(() => useOrchestratorRun(ID), { wrapper: makeWrapper(ref, send) });
    const started: ServerMessage = { type: "orchestrator:started", investigationId: ID };
    for (const m of [started,
      { type: "orchestrator:step", investigationId: ID, event: step(0) },
      { type: "orchestrator:step", investigationId: ID, event: step(1) },
      { type: "orchestrator:step", investigationId: ID, event: step(2) },
    ] as ServerMessage[]) {
      act(() => { ref.current = [...ref.current, m]; });
      rerender();
    }
    expect(result.current?.steps).toHaveLength(3);

    // Simulate compaction: the array shrinks (length 2 < 4 processed) but RETAINS
    // the original started + a freshly-arrived tail step. Only the tail step is new.
    act(() => { ref.current = [started, { type: "orchestrator:step", investigationId: ID, event: step(3) } as ServerMessage]; });
    rerender();
    // Run is NOT reset by the retained started, and steps are NOT duplicated:
    // the 3 existing + the 1 new tail step = 4.
    expect(result.current?.running).toBe(true);
    expect(result.current?.steps).toHaveLength(4);
  });

  it("exposes connectionStatus for the reconnect guard (D6)", () => {
    const ref = { current: [] as ServerMessage[] };
    const { result } = renderHook(() => useOrchestratorRunActions(), { wrapper: makeWrapper(ref, vi.fn(), "disconnected") });
    expect(result.current.connectionStatus).toBe("disconnected");
  });
});

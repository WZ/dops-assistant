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

  it("keeps duplicate-launch errors transient and clears them on pause or completion", () => {
    let m = applyMessage(empty(), { type: "orchestrator:started", investigationId: ID });
    m = applyMessage(m, { type: "orchestrator:error", investigationId: ID, message: "Already running for this report." });
    expect(m.get(ID)).toMatchObject({ running: true, error: "Already running for this report." });

    const paused = applyMessage(m, { type: "orchestrator:operator_pause", investigationId: ID, strikes: 3, hypothesesTried: ["a"] });
    expect(paused.get(ID)).toMatchObject({ running: true, error: null, pause: { strikes: 3, hypothesesTried: ["a"] } });

    m = applyMessage(m, {
      type: "orchestrator:complete",
      investigationId: ID,
      outcome: "confirmed",
      stats: { moves: 1, toolCalls: 1, subagents: 0, tokensSpent: 50, strikes: 0, depth: 1, durationMs: 1000 },
    });
    expect(m.get(ID)).toMatchObject({ running: false, error: null, outcome: "confirmed" });
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

  it("decide() forwards a trimmed lead with continue and echoes it locally (PR-4)", () => {
    const send = vi.fn();
    const ref = {
      current: [
        { type: "orchestrator:started", investigationId: ID },
        { type: "orchestrator:operator_pause", investigationId: ID, strikes: 3 },
      ] as ServerMessage[],
    };
    const { result } = renderHook(
      () => ({ run: useOrchestratorRun(ID), actions: useOrchestratorRunActions() }),
      { wrapper: makeWrapper(ref, send) },
    );
    act(() => result.current.actions.decide(ID, "continue", "  check the DB pool  "));
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_decision", investigationId: ID, decision: "continue", context: "check the DB pool" });
    // echoed locally so the pause bar shows it before the server round-trips
    expect(result.current.run?.operatorContext).toBe("check the DB pool");
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

// ── PR-2 (T5/T7): persisted-event replay + hydrate ───────────────────────────
//
// FROZEN fixtures. These are hand-written persisted rows as the server's
// persisting-send wrote them (schemaVersion 1), NOT generated from the current
// types. If the orchestrator message shape changes in a way the v1 replay can't
// read, these tests break — which is the point: the persisted log is a durable
// contract, and silent breakage of old investigations must be caught here.
type Row = { event_type: string; payload: string };
const envelope = (message: unknown) => JSON.stringify({ schemaVersion: 1, message });

// A run that ran to completion (started → 2 steps → complete).
const COMPLETED_RUN: Row[] = [
  { event_type: "orchestrator:started", payload: envelope({ type: "orchestrator:started", investigationId: ID }) },
  { event_type: "orchestrator:step", payload: envelope({ type: "orchestrator:step", investigationId: ID, event: { seq: 0, verb: "querying", status: "running" } }) },
  { event_type: "orchestrator:step", payload: envelope({ type: "orchestrator:step", investigationId: ID, event: { seq: 1, verb: "correlating", status: "running" } }) },
  { event_type: "orchestrator:complete", payload: envelope({
      type: "orchestrator:complete", investigationId: ID, outcome: "confirmed",
      stats: { moves: 2, toolCalls: 4, subagents: 0, tokensSpent: 900, strikes: 0, depth: 2, durationMs: 4321 },
      causalChain: [{ label: "incident: payments-api", kind: "incident" }, { label: "root cause: pool exhausted", kind: "root-cause" }],
      traceSummary: "2 moves · confirmed at depth 2",
    }) },
];

// A run that was mid-flight when the tab closed (started → step, no terminal).
const MIDFLIGHT_RUN: Row[] = [
  { event_type: "orchestrator:started", payload: envelope({ type: "orchestrator:started", investigationId: ID }) },
  { event_type: "orchestrator:step", payload: envelope({ type: "orchestrator:step", investigationId: ID, event: { seq: 0, verb: "querying", status: "running" } }) },
];

describe("hydrate — persisted-event replay (PR-2 schema v1)", () => {
  function mountWithActions() {
    const ref = { current: [] as ServerMessage[] };
    return renderHook(
      () => ({ run: useOrchestratorRun(ID), actions: useOrchestratorRunActions() }),
      { wrapper: makeWrapper(ref, vi.fn()) },
    );
  }

  it("reconstructs a COMPLETED run from frozen rows (steps, outcome, chain) and tags it hydrated", () => {
    const { result } = mountWithActions();
    act(() => result.current.actions.hydrate(ID, COMPLETED_RUN));
    const run = result.current.run!;
    expect(run.kind).toBe("orchestrator");
    expect(run.running).toBe(false);
    expect(run.outcome).toBe("confirmed");
    expect(run.steps).toHaveLength(2);
    expect(run.causalChain).toHaveLength(2);
    expect(run.traceSummary).toBe("2 moves · confirmed at depth 2");
    expect(run.hydrated).toBe(true);
  });

  it("replays steps in seq order regardless (rows already created_at-ordered by the GET)", () => {
    const { result } = mountWithActions();
    act(() => result.current.actions.hydrate(ID, COMPLETED_RUN));
    expect(result.current.run!.steps.map((s) => s.seq)).toEqual([0, 1]);
  });

  it("a MID-FLIGHT run reconstructs as still-running + hydrated (→ rendered INTERRUPTED)", () => {
    const { result } = mountWithActions();
    act(() => result.current.actions.hydrate(ID, MIDFLIGHT_RUN));
    const run = result.current.run!;
    expect(run.running).toBe(true);
    expect(run.hydrated).toBe(true);
    expect(run.steps).toHaveLength(1);
  });

  it("hydrate-if-absent: a live run already in the registry is NOT clobbered", () => {
    const ref = { current: [] as ServerMessage[] };
    const { result, rerender } = renderHook(
      () => ({ run: useOrchestratorRun(ID), actions: useOrchestratorRunActions() }),
      { wrapper: makeWrapper(ref, vi.fn()) },
    );
    // a live run arrives over WS first
    act(() => { ref.current = [...ref.current, { type: "orchestrator:started", investigationId: ID }]; });
    rerender();
    expect(result.current.run?.running).toBe(true);
    expect(result.current.run?.hydrated).toBeUndefined();
    // a late GET tries to hydrate the SAME id → no-op (live wins)
    act(() => result.current.actions.hydrate(ID, COMPLETED_RUN));
    expect(result.current.run?.hydrated).toBeUndefined();
    expect(result.current.run?.running).toBe(true);
  });

  it("rejects rows written by an unknown schemaVersion (forward-compat) → no run", () => {
    const { result } = mountWithActions();
    const future: Row[] = [
      { event_type: "orchestrator:started", payload: JSON.stringify({ schemaVersion: 999, message: { type: "orchestrator:started", investigationId: ID } }) },
    ];
    act(() => result.current.actions.hydrate(ID, future));
    expect(result.current.run).toBeUndefined();
  });

  it("ignores non-orchestrator and corrupt rows without crashing", () => {
    const { result } = mountWithActions();
    const mixed: Row[] = [
      { event_type: "investigation:phase", payload: envelope({ type: "investigation:phase" }) }, // not ours
      { event_type: "orchestrator:started", payload: "{not json" }, // corrupt
      ...COMPLETED_RUN,
    ];
    act(() => result.current.actions.hydrate(ID, mixed));
    // the corrupt orchestrator:started row is skipped, but the well-formed
    // started later in COMPLETED_RUN still reconstructs the run.
    expect(result.current.run?.running).toBe(false);
    expect(result.current.run?.steps).toHaveLength(2);
  });

  it("JSON round-trip of the envelope is stable (write → read identity)", () => {
    const message = { type: "orchestrator:started", investigationId: ID };
    const written = envelope(message);
    const read = JSON.parse(written) as { schemaVersion: number; message: unknown };
    expect(read.schemaVersion).toBe(1);
    expect(read.message).toEqual(message);
    expect(JSON.stringify(read.message)).toBe(JSON.stringify(message));
  });
});

// ── PR-2c (T7): reattach reducer — replay, seq-dedup, parked, decision_locked ──
const env2c = (message: unknown) => JSON.stringify({ schemaVersion: 1, message });
const row = (event_type: string, message: unknown) => ({ event_type, payload: env2c(message) });

describe("applyMessage — PR-2c reattach transitions", () => {
  it("orchestrator:step dedups a re-delivered seq (reattach overlap)", () => {
    let m = applyMessage(empty(), { type: "orchestrator:started", investigationId: ID });
    m = applyMessage(m, { type: "orchestrator:step", investigationId: ID, event: step(0) });
    m = applyMessage(m, { type: "orchestrator:step", investigationId: ID, event: step(1) });
    expect(m.get(ID)!.steps).toHaveLength(2);
    expect(m.get(ID)!.lastSeq).toBe(1);
    // a re-delivery of seq 1 (and 0) is dropped; seq 2 appends
    m = applyMessage(m, { type: "orchestrator:step", investigationId: ID, event: step(1) });
    m = applyMessage(m, { type: "orchestrator:step", investigationId: ID, event: step(0) });
    expect(m.get(ID)!.steps).toHaveLength(2);
    m = applyMessage(m, { type: "orchestrator:step", investigationId: ID, event: step(2) });
    expect(m.get(ID)!.steps).toHaveLength(3);
    expect(m.get(ID)!.lastSeq).toBe(2);
  });

  it("orchestrator:parked sets parked; a live step clears it", () => {
    let m = applyMessage(empty(), { type: "orchestrator:started", investigationId: ID });
    m = applyMessage(m, { type: "orchestrator:parked", investigationId: ID });
    expect(m.get(ID)!.parked).toBe(true);
    m = applyMessage(m, { type: "orchestrator:step", investigationId: ID, event: step(0) });
    expect(m.get(ID)!.parked).toBe(false);
  });

  it("orchestrator:decision_locked locks the decision on this tab too (D7 cross-tab)", () => {
    let m = applyMessage(empty(), { type: "orchestrator:started", investigationId: ID });
    m = applyMessage(m, { type: "orchestrator:operator_pause", investigationId: ID, strikes: 3 });
    expect(m.get(ID)!.decisionSubmitted).toBe(false);
    m = applyMessage(m, { type: "orchestrator:decision_locked", investigationId: ID });
    expect(m.get(ID)!.decisionSubmitted).toBe(true);
  });

  it("orchestrator:decision_locked carries the operator's lead into the run state (PR-4)", () => {
    let m = applyMessage(empty(), { type: "orchestrator:started", investigationId: ID });
    m = applyMessage(m, { type: "orchestrator:operator_pause", investigationId: ID, strikes: 3 });
    m = applyMessage(m, { type: "orchestrator:decision_locked", investigationId: ID, context: "check the DB pool" });
    expect(m.get(ID)!.operatorContext).toBe("check the DB pool");
  });

  it("orchestrator:accept_rejected clears a pending optimistic apply state", () => {
    let m = applyMessage(empty(), { type: "orchestrator:started", investigationId: ID });
    m = applyMessage(m, {
      type: "orchestrator:complete",
      investigationId: ID,
      outcome: "confirmed",
    });
    m = applyMessage(m, { type: "orchestrator:refining", investigationId: ID });
    expect(m.get(ID)!.refining).toBe(true);

    m = applyMessage(m, {
      type: "orchestrator:accept_rejected",
      investigationId: ID,
      message: "Editing reports is disabled.",
    });
    expect(m.get(ID)!.refining).toBe(false);
    expect(m.get(ID)!.acceptError).toBe("Editing reports is disabled.");
  });

  it("orchestrator:replay reconstructs a LIVE run (clears hydrated/parked, seeds lastSeq)", () => {
    const events = [
      row("orchestrator:started", { type: "orchestrator:started", investigationId: ID }),
      row("orchestrator:step", { type: "orchestrator:step", investigationId: ID, event: step(0) }),
      row("orchestrator:step", { type: "orchestrator:step", investigationId: ID, event: step(1) }),
    ];
    const m = applyMessage(empty(), { type: "orchestrator:replay", investigationId: ID, events, live: true });
    const run = m.get(ID)!;
    expect(run.running).toBe(true);
    expect(run.hydrated).toBeFalsy();
    expect(run.parked).toBeFalsy();
    expect(run.steps).toHaveLength(2);
    expect(run.lastSeq).toBe(1);
  });

  it("orchestrator:replay clears INTERRUPTED on a previously-hydrated run", () => {
    // hydrated/interrupted run already present
    let m: ReadonlyMap<string, DeepRunState> = new Map([[ID, { kind: "orchestrator", running: true, steps: [step(0)], error: null, collapsed: false, hydrated: true, lastSeq: 0 }]]);
    const events = [
      row("orchestrator:started", { type: "orchestrator:started", investigationId: ID }),
      row("orchestrator:step", { type: "orchestrator:step", investigationId: ID, event: step(0) }),
      row("orchestrator:step", { type: "orchestrator:step", investigationId: ID, event: step(1) }),
    ];
    m = applyMessage(m, { type: "orchestrator:replay", investigationId: ID, events, live: true });
    expect(m.get(ID)!.hydrated).toBeFalsy(); // no longer interrupted
    expect(m.get(ID)!.steps).toHaveLength(2);
  });

  it("orchestrator:replay is race-safe — it never rolls back live steps already ahead", () => {
    // live run already at seq 3
    let m: ReadonlyMap<string, DeepRunState> = new Map([[ID, { kind: "orchestrator", running: true, steps: [step(0), step(1), step(2), step(3)], error: null, collapsed: false, lastSeq: 3 }]]);
    // a late replay carrying only up to seq 1 must NOT shrink the run
    const events = [
      row("orchestrator:started", { type: "orchestrator:started", investigationId: ID }),
      row("orchestrator:step", { type: "orchestrator:step", investigationId: ID, event: step(0) }),
      row("orchestrator:step", { type: "orchestrator:step", investigationId: ID, event: step(1) }),
    ];
    m = applyMessage(m, { type: "orchestrator:replay", investigationId: ID, events, live: true });
    expect(m.get(ID)!.steps).toHaveLength(4);
    expect(m.get(ID)!.lastSeq).toBe(3);
  });

  it("orchestrator:not_live leaves a hydrated (non-parked) run untouched", () => {
    const m0: ReadonlyMap<string, DeepRunState> = new Map([[ID, { kind: "orchestrator", running: true, steps: [step(0)], error: null, collapsed: false, hydrated: true }]]);
    const m = applyMessage(m0, { type: "orchestrator:not_live", investigationId: ID });
    expect(m).toBe(m0); // same identity — no change
  });

  it("orchestrator:not_live clears parked on a hydrated run → renders INTERRUPTED (server gone)", () => {
    // cold-load hydrated a persisted `parked` run, but the server no longer has it
    const m0: ReadonlyMap<string, DeepRunState> = new Map([[ID, { kind: "orchestrator", running: true, steps: [step(0)], error: null, collapsed: false, hydrated: true, parked: true }]]);
    const m = applyMessage(m0, { type: "orchestrator:not_live", investigationId: ID });
    expect(m.get(ID)!.parked).toBe(false);
    expect(m.get(ID)!.hydrated).toBe(true); // hydrated+running+!parked → interrupted, not "resuming…" forever
  });
});

describe("OrchestratorRunProvider — subscribe/unsubscribe actions", () => {
  it("subscribe() and unsubscribe() send the matching client messages", () => {
    const send = vi.fn();
    const ref = { current: [] as ServerMessage[] };
    const { result } = renderHook(() => useOrchestratorRunActions(), { wrapper: makeWrapper(ref, send) });
    act(() => result.current.subscribe(ID));
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_subscribe", investigationId: ID });
    act(() => result.current.unsubscribe(ID));
    expect(send).toHaveBeenCalledWith({ type: "orchestrator_unsubscribe", investigationId: ID });
  });
});

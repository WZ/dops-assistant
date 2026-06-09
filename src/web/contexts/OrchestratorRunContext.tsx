/**
 * Deep Investigation — run registry (PR-1, task T1).
 *
 * A single source of truth for in-flight "Deep Investigation" runs, lifted out
 * of InvestigationPane so BOTH the legacy investigation card AND the new Console
 * inline projection read the same state (no divergent copies).
 *
 * Shape: a registry keyed by investigationId, holding a *tagged* run
 * (`kind: "orchestrator" | "deep-mode"`) so both run engines render through one
 * surface (decision D3). The provider processes the `orchestrator:*` and
 * `deep_mode:*` WebSocket messages exactly ONCE (decision D1) and exposes
 * command helpers (`start` / `decide`) that send the matching client messages.
 *
 * This is intentionally a *projection of a run artifact*, not chat data
 * (decision D2): when PR-2 adds server-side persistence, it rehydrates this
 * registry without touching the chat thread.
 *
 *        wsMessages ──▶ ┌─────────────────────────────┐
 *        wsStatus  ──▶  │  OrchestratorRunProvider      │
 *        wsSend    ──▶  │   runs: Map<id, RunState>      │──▶ useOrchestratorRun(id)
 *                       │   start(id,scope)·decide(id,d) │──▶ useOrchestratorRunActions()
 *                       └─────────────────────────────┘
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ServerMessage,
  ClientMessage,
  AgentStreamEvent,
  AgentStreamStats,
  OrchestratorStreamStats,
  CausalChainLink,
  DeepInvestigationEventEnvelope,
  PersistedInvestigationEvent,
} from "../../types/ws-types.js";
import { DEEP_INVESTIGATION_EVENT_SCHEMA } from "../../types/ws-types.js";
import type { OrchestratorPause, OrchestratorDisposition } from "../components/OrchestratorStream";

/** Which engine produced this run. Both render through the one inline surface. */
export type DeepRunKind = "orchestrator" | "deep-mode";

/** The scope an operator picks from the "Investigate deeply" menu. */
export type DeepRunScope = "challenge" | "full";

/** A pause decision the operator can send (3-enum in PR-1; PR-4 adds context). */
export type OperatorDecision = "continue" | "escalate" | "wait";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * One run's full state. A tagged union by `kind`, but kept as a single flat
 * interface (optional per-kind fields) so the inline projection can switch on
 * `kind` without two parallel maps. Mirrors exactly what InvestigationPane held
 * locally before the lift.
 */
export interface DeepRunState {
  readonly kind: DeepRunKind;
  readonly running: boolean;
  readonly steps: AgentStreamEvent[];
  /** Epoch ms when the run started, stamped on the `*:started` message. The
   *  elapsed timers anchor to this (not to component mount) so they keep counting
   *  correctly when the operator navigates away from the Console and back — the
   *  run lives in the registry, so this survives the inline region unmounting. */
  readonly startedAt?: number;
  /** Shared: an engine/LLM/MCP error message (run stopped), else null. */
  readonly error: string | null;
  /** UI: whether the inline region is collapsed to its one-line summary (DZ2). */
  readonly collapsed: boolean;
  /** True when this run was reconstructed from persisted events on a cold load
   *  rather than observed live (PR-2). A hydrated run that is still `running`
   *  was mid-flight when the page last closed → the inline surface renders it as
   *  INTERRUPTED, since no live stream is feeding it. Cleared when a live stream
   *  reattaches (PR-2c `orchestrator:replay` / a live step). */
  readonly hydrated?: boolean;
  /** True while the server has parked this run (no viewer for the idle window,
   *  PR-2c). Resumes automatically when this client reattaches; a step clears it. */
  readonly parked?: boolean;
  /** Highest orchestrator step `seq` applied — used to dedup the overlap between
   *  a reattach replay and the live tail (PR-2c). */
  readonly lastSeq?: number;

  // ── orchestrator-only ──────────────────────────────────────────────
  readonly outcome?: string;
  readonly causalChain?: CausalChainLink[];
  readonly traceSummary?: string;
  readonly orchStats?: OrchestratorStreamStats;
  /** Set while blocked at the strike limit awaiting an operator call. */
  readonly pause?: OrchestratorPause | null;
  /** The disposition chosen at the last pause (escalate/wait), for the banner. */
  readonly disposition?: OrchestratorDisposition;
  /** D7: true once a pause decision was sent — locks the controls on every
   *  surface so two panes can't submit conflicting decisions. Cleared when the
   *  loop resumes (next step) or the run completes. */
  readonly decisionSubmitted?: boolean;
  /** PR-4: the operator's free-text lead from a continue-with-context decision,
   *  set locally on submit and from the persisted/replayed decision_locked event.
   *  Shown read-only on the pause bar ("steered with: …"). */
  readonly operatorContext?: string;
  /** PR-6b: true once the operator applied this confirmed run's conclusion back
   *  into the RCA report (server `orchestrator:accepted`). Flips the Console's
   *  "Apply to report" action to a "✓ applied" confirmation. */
  readonly accepted?: boolean;
  /** PR-6b: true while the server is re-synthesizing the report after an apply
   *  (the seconds-long LLM pass). Drives the "Re-synthesizing report…" state. */
  readonly refining?: boolean;
  /** PR-6b: a friendly reason the last apply attempt was rejected, else null. */
  readonly acceptError?: string | null;

  // ── deep-mode-only ─────────────────────────────────────────────────
  readonly report?: unknown;
  readonly deepStats?: AgentStreamStats;
}

interface OrchestratorRunContextValue {
  readonly runs: ReadonlyMap<string, DeepRunState>;
  /** Convenience accessor (identical to `runs.get(id)`). */
  getRun: (investigationId: string) => DeepRunState | undefined;
  /** Kick a run: "challenge" → deep_mode_investigate, "full" → orchestrator_investigate. */
  start: (investigationId: string, scope: DeepRunScope) => void;
  /** Send a strike-limit pause decision. No-ops if one was already submitted (D7). */
  decide: (investigationId: string, decision: OperatorDecision, context?: string) => void;
  /** Stop an in-flight run (server aborts it → outcome "aborted"). */
  stop: (investigationId: string) => void;
  /** PR-6b: apply a confirmed orchestrator run's conclusion back into the RCA
   *  report. The server reads the authoritative result from the persisted
   *  complete-event; this only carries the id. */
  accept: (investigationId: string) => void;
  /** Toggle the inline region's collapsed state (DZ2). */
  setCollapsed: (investigationId: string, collapsed: boolean) => void;
  /** Reconstruct a run from persisted events on cold load (PR-2). Hydrate-if-
   *  absent: no-ops if a run for this id already exists (live always wins). */
  hydrate: (investigationId: string, events: readonly PersistedInvestigationEvent[]) => void;
  /** Reattach to a live server-side run (PR-2c): the server replays history then
   *  streams live (orchestrator:replay), or answers not_live to keep the cold render. */
  subscribe: (investigationId: string) => void;
  /** Detach from a run's live stream (navigating away). */
  unsubscribe: (investigationId: string) => void;
  /** WS connection status — drives the "disable Full while reconnecting" guard (D6). */
  connectionStatus: ConnectionStatus;
}

const OrchestratorRunContext = createContext<OrchestratorRunContextValue | null>(null);

/** A fresh run record for a `*:started` message of the given kind. `startedAt`
 *  anchors the elapsed timers so they survive the inline region unmounting. */
function freshRun(kind: DeepRunKind): DeepRunState {
  return { kind, running: true, steps: [], error: null, collapsed: false, startedAt: Date.now() };
}

/** Reconstruct one run by replaying its persisted event envelopes through the
 *  SAME reducer that processes them live, so a rebuilt run is byte-identical to
 *  one observed live. Shared by `hydrate` (cold load) and the `orchestrator:replay`
 *  reattach (PR-2c). Corrupt rows and unknown schema versions are skipped. */
function reconstructFromEvents(events: readonly PersistedInvestigationEvent[]): DeepRunState | undefined {
  let replayed: ReadonlyMap<string, DeepRunState> = new Map();
  let id: string | undefined;
  for (const ev of events) {
    if (!ev.event_type.startsWith("orchestrator:")) continue;
    let envelope: DeepInvestigationEventEnvelope;
    try {
      envelope = JSON.parse(ev.payload) as DeepInvestigationEventEnvelope;
    } catch {
      continue;
    }
    if (envelope.schemaVersion !== DEEP_INVESTIGATION_EVENT_SCHEMA || !envelope.message) continue;
    const m = envelope.message;
    if ("investigationId" in m && typeof m.investigationId === "string") id = m.investigationId;
    replayed = applyMessage(replayed, m);
  }
  return id ? replayed.get(id) : undefined;
}

/** Highest step `seq` in a run (−1 if none) — the dedup high-water mark. */
function maxSeq(run: DeepRunState): number {
  return run.steps.reduce((mx, s) => (typeof s.seq === "number" && s.seq > mx ? s.seq : mx), -1);
}

/**
 * Apply one server message to the registry, returning a NEW map only when the
 * message actually changes a run (so unrelated messages don't churn consumers).
 * Pure given (map, msg). Mirrors InvestigationPane's former handlers 1:1.
 */
export function applyMessage(
  runs: ReadonlyMap<string, DeepRunState>,
  msg: ServerMessage,
): ReadonlyMap<string, DeepRunState> {
  // Narrow to the messages we own; everything else passes through untouched.
  if (!("investigationId" in msg) || typeof msg.investigationId !== "string") return runs;
  const id = msg.investigationId;
  const prev = runs.get(id);
  const set = (next: DeepRunState): ReadonlyMap<string, DeepRunState> => {
    const m = new Map(runs);
    m.set(id, next);
    return m;
  };

  switch (msg.type) {
    // ── deep-mode (the "Challenge this RCA" scope) ────────────────────
    case "deep_mode:started":
      return set(freshRun("deep-mode"));
    case "deep_mode:step":
      if (!prev) return runs;
      return set({ ...prev, steps: [...prev.steps, msg.event] });
    case "deep_mode:complete":
      if (!prev) return runs;
      return set({ ...prev, running: false, report: msg.report, deepStats: msg.stats });
    case "deep_mode:error":
      if (!prev) return runs;
      return set({ ...prev, running: false, error: typeof msg.message === "string" ? msg.message : "Deep mode failed." });

    // ── orchestrator (the "Full deep investigation" scope) ────────────
    case "orchestrator:started":
      return set(freshRun("orchestrator"));
    case "orchestrator:step": {
      if (!prev) return runs;
      // Dedup the reattach overlap (PR-2c): a step whose seq we already applied
      // (from a replay or hydrate) is a re-delivery — drop it.
      const seq = msg.event.seq;
      if (typeof seq === "number" && prev.lastSeq !== undefined && seq <= prev.lastSeq) return runs;
      // A new move means the loop resumed past any pause/park — clear the pause
      // card, the submit-lock, and the parked flag so the surface shows live again.
      return set({
        ...prev,
        steps: [...prev.steps, msg.event],
        pause: null,
        decisionSubmitted: false,
        parked: false,
        lastSeq: typeof seq === "number" ? seq : prev.lastSeq,
      });
    }
    case "orchestrator:operator_pause":
      if (!prev) return runs;
      return set({ ...prev, pause: { strikes: msg.strikes, hypothesesTried: msg.hypothesesTried }, decisionSubmitted: false });
    // PR-2c reattach: a one-shot catch-up. Reconstruct the run from the replayed
    // history and mark it LIVE (not hydrated/interrupted, not parked); subsequent
    // live steps dedup against lastSeq. Race-safe: if we already hold a live run
    // that is at or ahead of the replay (a live step landed between subscribe and
    // replay), don't roll it back — just clear the hydrated/parked flags.
    case "orchestrator:replay": {
      const rebuilt = reconstructFromEvents(msg.events);
      if (!rebuilt) return runs;
      const rebuiltSeq = maxSeq(rebuilt);
      const prevSeq = prev ? (prev.lastSeq ?? maxSeq(prev)) : -1;
      if (prev && prevSeq >= rebuiltSeq && prev.steps.length >= rebuilt.steps.length) {
        if (!prev.hydrated && !prev.parked) return runs; // already live & ahead — nothing to change
        return set({ ...prev, hydrated: false, parked: false });
      }
      return set({ ...rebuilt, hydrated: false, parked: false, lastSeq: rebuiltSeq });
    }
    // No live run server-side (server restart / GC). Clear an optimistic `parked`
    // flag so a hydrated run falls back to INTERRUPTED rendering instead of
    // claiming "resuming…" forever; otherwise keep the cold GET/hydrate render.
    case "orchestrator:not_live":
      if (prev?.parked) return set({ ...prev, parked: false });
      return runs;
    // The server parked a viewerless run (PR-2c). Show "Parked"; a reattach + step resumes.
    case "orchestrator:parked":
      if (!prev) return runs;
      return set({ ...prev, parked: true });
    // The first pause decision (from any tab) was accepted — lock controls here too (D7).
    case "orchestrator:decision_locked":
      if (!prev) return runs;
      // PR-4: capture the operator's lead (if any) so a reattaching tab / cold
      // replay shows what the human steered with. Keep any locally-echoed lead if
      // the persisted event carries none.
      return set({ ...prev, decisionSubmitted: true, operatorContext: msg.context ?? prev.operatorContext });
    case "orchestrator:complete":
      if (!prev) return runs;
      return set({
        ...prev,
        running: false,
        pause: null,
        decisionSubmitted: false,
        orchStats: msg.stats,
        outcome: msg.outcome,
        causalChain: msg.causalChain,
        traceSummary: msg.traceSummary,
      });
    case "orchestrator:error":
      if (!prev) return runs;
      return set({ ...prev, running: false, pause: null, error: typeof msg.message === "string" ? msg.message : "The orchestrator hit an error." });

    // PR-6b: report re-synthesis is in flight after an apply.
    case "orchestrator:refining":
      if (!prev) return runs;
      return set({ ...prev, refining: true, acceptError: null });
    // PR-6b: the operator applied this confirmed run to the report. Mark accepted
    // (clear refining + any prior reject error) so the Console flips to "✓ applied".
    case "orchestrator:accepted":
      if (!prev) return runs;
      return set({ ...prev, accepted: true, refining: false, acceptError: null });
    // PR-6b: the apply was rejected — surface the reason on the run for the strip.
    case "orchestrator:accept_rejected":
      if (!prev) return runs;
      return set({ ...prev, refining: false, acceptError: typeof msg.message === "string" ? msg.message : "Couldn't apply to the report." });

    default:
      return runs;
  }
}

export function OrchestratorRunProvider({
  wsMessages,
  wsSend,
  connectionStatus,
  children,
}: {
  wsMessages: ServerMessage[];
  wsSend: (msg: ClientMessage) => void;
  connectionStatus: ConnectionStatus;
  children: ReactNode;
}) {
  const [runs, setRuns] = useState<ReadonlyMap<string, DeepRunState>>(() => new Map());
  // High-water mark of consumed messages. useWebSocket clears `messages` to []
  // on stack switch, so a shrink means "reset and reprocess from 0".
  const processedRef = useRef(0);
  // Latest runs, readable synchronously inside callbacks (a setRuns updater runs
  // asynchronously, so the submit-lock check can't depend on its side effects).
  const runsRef = useRef(runs);
  runsRef.current = runs;

  useEffect(() => {
    const prevProcessed = processedRef.current;
    let batch: ServerMessage[];
    if (wsMessages.length === 0) {
      // Genuine clear (stack switch — useWebSocket setMessages([])). Reset; there
      // is nothing to process.
      processedRef.current = 0;
      return;
    } else if (wsMessages.length < prevProcessed) {
      // useWebSocket COMPACTED the buffer (slice to the last 1500). The retained
      // messages were already processed — replaying them would duplicate streamed
      // steps or reset a live run on a retained *:started. Only the just-arrived
      // tail message (the one that pushed past the cap) is new.
      batch = wsMessages.slice(-1);
      processedRef.current = wsMessages.length;
    } else if (prevProcessed >= wsMessages.length) {
      processedRef.current = wsMessages.length;
      return;
    } else {
      batch = wsMessages.slice(prevProcessed);
      processedRef.current = wsMessages.length;
    }
    setRuns((prev) => {
      let next = prev;
      for (const msg of batch) next = applyMessage(next, msg);
      return next;
    });
  }, [wsMessages]);

  const start = useCallback(
    (investigationId: string, scope: DeepRunScope) => {
      wsSend(
        scope === "challenge"
          ? { type: "deep_mode_investigate", investigationId }
          : { type: "orchestrator_investigate", investigationId },
      );
    },
    [wsSend],
  );

  const decide = useCallback(
    (investigationId: string, decision: OperatorDecision, context?: string) => {
      // D7: optimistic submit-lock. If a decision was already submitted for this
      // run, ignore the second click (from either surface) entirely. Check the
      // current state synchronously via the ref — a setRuns updater runs later,
      // so its side effects can't gate the send.
      const run = runsRef.current.get(investigationId);
      if (!run || run.decisionSubmitted) return;
      // PR-4: a lead is only meaningful with "continue"; trim and drop if empty.
      const lead = decision === "continue" ? context?.trim() || undefined : undefined;
      setRuns((prev) => {
        const cur = prev.get(investigationId);
        if (!cur || cur.decisionSubmitted) return prev;
        const m = new Map(prev);
        m.set(investigationId, {
          ...cur,
          decisionSubmitted: true,
          // continue resumes (disposition stays); escalate/wait record intent.
          disposition: decision === "continue" ? cur.disposition : decision,
          // Echo the lead locally so the pause bar shows it immediately, before the
          // server's decision_locked round-trips back.
          operatorContext: lead ?? cur.operatorContext,
        });
        return m;
      });
      wsSend({ type: "orchestrator_decision", investigationId, decision, context: lead });
    },
    [wsSend],
  );

  const stop = useCallback(
    (investigationId: string) => {
      wsSend({ type: "orchestrator_stop", investigationId });
    },
    [wsSend],
  );

  const accept = useCallback(
    (investigationId: string) => {
      // Id-only: the server merges the authoritative result from the persisted
      // complete-event. Optimistically flip to "refining" (clearing any prior
      // reject error) so the Apply control shows "Re-synthesizing…" instantly,
      // before the server's orchestrator:refining round-trips back.
      setRuns((prev) => {
        const cur = prev.get(investigationId);
        if (!cur || cur.accepted || cur.refining) return prev;
        const m = new Map(prev);
        m.set(investigationId, { ...cur, refining: true, acceptError: null });
        return m;
      });
      wsSend({ type: "orchestrator_accept", investigationId });
    },
    [wsSend],
  );

  const setCollapsed = useCallback((investigationId: string, collapsed: boolean) => {
    setRuns((prev) => {
      const run = prev.get(investigationId);
      if (!run || run.collapsed === collapsed) return prev;
      const m = new Map(prev);
      m.set(investigationId, { ...run, collapsed });
      return m;
    });
  }, []);

  const hydrate = useCallback((investigationId: string, events: readonly PersistedInvestigationEvent[]) => {
    setRuns((prev) => {
      // Hydrate-if-absent (D): a live run already in the registry is authoritative
      // — never clobber it (or an earlier hydration) with replayed history.
      if (prev.has(investigationId)) return prev;
      const run = reconstructFromEvents(events);
      if (!run) return prev;
      const m = new Map(prev);
      // hydrated:true → renders INTERRUPTED if still running, until a live reattach
      // (orchestrator:replay / a live step) clears it. lastSeq seeds the reattach dedup.
      m.set(investigationId, { ...run, hydrated: true, lastSeq: maxSeq(run) });
      return m;
    });
  }, []);

  const subscribe = useCallback((investigationId: string) => {
    wsSend({ type: "orchestrator_subscribe", investigationId });
  }, [wsSend]);

  const unsubscribe = useCallback((investigationId: string) => {
    wsSend({ type: "orchestrator_unsubscribe", investigationId });
  }, [wsSend]);

  const getRun = useCallback((investigationId: string) => runs.get(investigationId), [runs]);

  const value = useMemo<OrchestratorRunContextValue>(
    () => ({ runs, getRun, start, decide, stop, accept, setCollapsed, hydrate, subscribe, unsubscribe, connectionStatus }),
    [runs, getRun, start, decide, stop, accept, setCollapsed, hydrate, subscribe, unsubscribe, connectionStatus],
  );

  return <OrchestratorRunContext.Provider value={value}>{children}</OrchestratorRunContext.Provider>;
}

function useOrchestratorRunContext(): OrchestratorRunContextValue {
  const ctx = useContext(OrchestratorRunContext);
  if (!ctx) throw new Error("useOrchestratorRun* must be used within an OrchestratorRunProvider");
  return ctx;
}

/** Subscribe to one investigation's run state. Undefined until a run starts. */
export function useOrchestratorRun(investigationId: string | null | undefined): DeepRunState | undefined {
  const { runs } = useOrchestratorRunContext();
  return investigationId ? runs.get(investigationId) : undefined;
}

/** Subscribe to the whole registry (e.g. a cross-run notifier). */
export function useOrchestratorRuns(): ReadonlyMap<string, DeepRunState> {
  return useOrchestratorRunContext().runs;
}

/** The command helpers + connection status (no per-run subscription). */
export function useOrchestratorRunActions(): Pick<
  OrchestratorRunContextValue,
  "start" | "decide" | "stop" | "accept" | "setCollapsed" | "hydrate" | "subscribe" | "unsubscribe" | "connectionStatus"
> {
  const { start, decide, stop, accept, setCollapsed, hydrate, subscribe, unsubscribe, connectionStatus } = useOrchestratorRunContext();
  return { start, decide, stop, accept, setCollapsed, hydrate, subscribe, unsubscribe, connectionStatus };
}

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
  /** Shared: an engine/LLM/MCP error message (run stopped), else null. */
  readonly error: string | null;
  /** UI: whether the inline region is collapsed to its one-line summary (DZ2). */
  readonly collapsed: boolean;
  /** True when this run was reconstructed from persisted events on a cold load
   *  rather than observed live (PR-2). A hydrated run that is still `running`
   *  was mid-flight when the page last closed → the inline surface renders it as
   *  INTERRUPTED, since no live stream is feeding it. */
  readonly hydrated?: boolean;

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
  decide: (investigationId: string, decision: OperatorDecision) => void;
  /** Stop an in-flight run (server aborts it → outcome "aborted"). */
  stop: (investigationId: string) => void;
  /** Toggle the inline region's collapsed state (DZ2). */
  setCollapsed: (investigationId: string, collapsed: boolean) => void;
  /** Reconstruct a run from persisted events on cold load (PR-2). Hydrate-if-
   *  absent: no-ops if a run for this id already exists (live always wins). */
  hydrate: (investigationId: string, events: readonly PersistedInvestigationEvent[]) => void;
  /** WS connection status — drives the "disable Full while reconnecting" guard (D6). */
  connectionStatus: ConnectionStatus;
}

const OrchestratorRunContext = createContext<OrchestratorRunContextValue | null>(null);

/** A fresh run record for a `*:started` message of the given kind. */
function freshRun(kind: DeepRunKind): DeepRunState {
  return { kind, running: true, steps: [], error: null, collapsed: false };
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
    case "orchestrator:step":
      if (!prev) return runs;
      // A new move means the loop resumed past any pause — clear the pause card
      // and the submit-lock so the next pause is actionable again.
      return set({ ...prev, steps: [...prev.steps, msg.event], pause: null, decisionSubmitted: false });
    case "orchestrator:operator_pause":
      if (!prev) return runs;
      return set({ ...prev, pause: { strikes: msg.strikes, hypothesesTried: msg.hypothesesTried }, decisionSubmitted: false });
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
    (investigationId: string, decision: OperatorDecision) => {
      // D7: optimistic submit-lock. If a decision was already submitted for this
      // run, ignore the second click (from either surface) entirely. Check the
      // current state synchronously via the ref — a setRuns updater runs later,
      // so its side effects can't gate the send.
      const run = runsRef.current.get(investigationId);
      if (!run || run.decisionSubmitted) return;
      setRuns((prev) => {
        const cur = prev.get(investigationId);
        if (!cur || cur.decisionSubmitted) return prev;
        const m = new Map(prev);
        m.set(investigationId, {
          ...cur,
          decisionSubmitted: true,
          // continue resumes (disposition stays); escalate/wait record intent.
          disposition: decision === "continue" ? cur.disposition : decision,
        });
        return m;
      });
      wsSend({ type: "orchestrator_decision", investigationId, decision });
    },
    [wsSend],
  );

  const stop = useCallback(
    (investigationId: string) => {
      wsSend({ type: "orchestrator_stop", investigationId });
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
      // Replay the persisted orchestrator events through the SAME reducer that
      // processes them live, so a reconstructed run is byte-identical to one we
      // observed. Build it up in an isolated map, then graft just this id in.
      let replayed: ReadonlyMap<string, DeepRunState> = new Map();
      for (const ev of events) {
        if (!ev.event_type.startsWith("orchestrator:")) continue;
        let envelope: DeepInvestigationEventEnvelope;
        try {
          envelope = JSON.parse(ev.payload) as DeepInvestigationEventEnvelope;
        } catch {
          continue; // a corrupt row can't sink the whole replay
        }
        // Forward-compat: skip rows written by a schema this client can't read,
        // rather than mis-reconstructing a run from a changed event shape.
        if (envelope.schemaVersion !== DEEP_INVESTIGATION_EVENT_SCHEMA || !envelope.message) continue;
        replayed = applyMessage(replayed, envelope.message);
      }
      const run = replayed.get(investigationId);
      if (!run) return prev;
      const m = new Map(prev);
      m.set(investigationId, { ...run, hydrated: true });
      return m;
    });
  }, []);

  const getRun = useCallback((investigationId: string) => runs.get(investigationId), [runs]);

  const value = useMemo<OrchestratorRunContextValue>(
    () => ({ runs, getRun, start, decide, stop, setCollapsed, hydrate, connectionStatus }),
    [runs, getRun, start, decide, stop, setCollapsed, hydrate, connectionStatus],
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
  "start" | "decide" | "stop" | "setCollapsed" | "hydrate" | "connectionStatus"
> {
  const { start, decide, stop, setCollapsed, hydrate, connectionStatus } = useOrchestratorRunContext();
  return { start, decide, stop, setCollapsed, hydrate, connectionStatus };
}

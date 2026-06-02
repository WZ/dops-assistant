/**
 * Autonomous investigation orchestrator (Approach D) — core control loop.
 *
 * This is the move-loop + safety harness + hybrid stop signal. It is a NEW
 * agent that WRAPS the fixed investigation DAG (it does not replace it):
 * `spawn-subagent` runs `runInvestigation` scoped to a sub-question, and the
 * Step-2 corroboration keystone (`evaluatePrediction`) is the stop gate.
 *
 * Increment 1 (this file): pure, fully-injected control flow so it is
 * unit-testable without an LLM or MCP. Moves implemented: hypothesize, query,
 * test, conclude. `spawn-subagent` / `follow-cause` are recognized but deferred
 * to later increments (they no-op with a trace entry). The real LLM decide-fn,
 * evidence gather, and keystone are wired in a later increment via OrchestratorDeps.
 *
 * DECISION 1 (hybrid stop) — the crux: the agent may PROPOSE `conclude`, but the
 * loop only actually stops on a `conclude` when the leading hypothesis is
 * DETERMINISTICALLY confirmed by the keystone (its latest verdict is
 * "satisfied"). The LLM's self-reported confidence is recorded but is NEVER the
 * gate. Self-confidence can DIRECT the search; it can never END it. The only
 * other ways the loop ends are guard trips (Decision 2).
 *
 * DECISION 2 (safety harness): budget (tokens), depth (subagent nesting),
 * strikes (consecutive rule-outs → operator pause), tool-cap, wall-clock. All
 * hard limits, all config-tunable. Strikes hitting the limit is a first-class
 * `operator-pause` outcome, not a silent stop.
 */
import type { RankedHypothesis } from "../types/rca-types.js";
import type {
  NormalizedObservation,
  HypothesisPrediction,
  Verdict,
} from "../workflows/steps/corroboration.js";

/** The moves the orchestrator LLM can pick at each step. */
export type OrchestratorMove =
  /** Add a candidate root cause (with a structured, checkable prediction). */
  | { type: "hypothesize"; hypothesis: RankedHypothesis }
  /** Gather read-only evidence for hypotheses[target]'s prediction. */
  | { type: "query"; target: number }
  /** Score hypotheses[target] against gathered evidence via the keystone. */
  | { type: "test"; target: number }
  /** Propose done. Gated — see DECISION 1. `confidence` is advisory only. */
  | { type: "conclude"; leading: number; confidence: number; rationale: string }
  /** Scoped sub-investigation on a service (increment 3 — deferred). */
  | { type: "spawn-subagent"; service: string; question: string }
  /** Follow the cause into a dependent service (increment 4 — deferred). */
  | { type: "follow-cause"; service: string };

export type HypothesisStanding = "open" | "confirmed" | "ruled-out";

export interface TrackedHypothesis {
  hypothesis: RankedHypothesis;
  standing: HypothesisStanding;
  /** Most recent deterministic keystone verdict, if tested. */
  lastVerdict?: Verdict;
}

export interface TraceEntry {
  move: OrchestratorMove["type"];
  detail: string;
  verdict?: Verdict;
}

/** Read-only view handed to the decide-fn each step. */
export interface OrchestratorState {
  readonly hypotheses: ReadonlyArray<TrackedHypothesis>;
  readonly evidence: ReadonlyArray<NormalizedObservation>;
  readonly depth: number;
  /** Consecutive ruled-out tests since the last confirmation. */
  readonly strikes: number;
  readonly tokensSpent: number;
  readonly toolCalls: number;
  readonly elapsedMs: number;
  readonly trace: ReadonlyArray<TraceEntry>;
}

export type OrchestratorOutcome =
  | "confirmed" // hybrid stop: leading hypothesis deterministically satisfied
  | "operator-pause" // strikes limit → hand back to a human
  | "budget-exhausted"
  | "tool-cap"
  | "wall-clock"
  | "exhausted" // decide-fn signalled no further moves
  | "inconclusive"; // stalled (no progress) or hit the move backstop

export interface OrchestratorGuards {
  /** Output-token budget. */
  maxTokens: number;
  /** Subagent / follow-cause nesting depth. */
  maxDepth: number;
  /** Consecutive rule-outs before pausing for an operator. */
  maxStrikes: number;
  /** Total read-only queries. */
  maxToolCalls: number;
  /** Wall-clock budget in ms. */
  wallClockMs: number;
}

export interface OrchestratorDeps {
  /**
   * The agent's brain: pick the next move from the current state. In prod this
   * is an LLM; in tests it's a scripted sequence. Return `null` to signal "no
   * further moves" (→ `exhausted`).
   */
  decideMove: (state: OrchestratorState) => Promise<OrchestratorMove | null>;
  /** Read-only evidence gather for a hypothesis's prediction (createGatherEvidence in prod). */
  gatherEvidence: (hypothesis: RankedHypothesis) => Promise<NormalizedObservation[]>;
  /** Deterministic keystone (evaluatePrediction in prod). */
  evaluate: (prediction: HypothesisPrediction, evidence: NormalizedObservation[]) => Verdict;
  guards: OrchestratorGuards;
  /** Injected clock so wall-clock is testable. Defaults to Date.now. */
  now?: () => number;
  /** Output-token estimate per move, for budget accounting. Defaults to 0. */
  estimateTokens?: (move: OrchestratorMove) => number;
  /** Live progress sink (the agent-stream UX wires this). */
  onStep?: (entry: TraceEntry) => void;
}

export interface OrchestratorResult {
  outcome: OrchestratorOutcome;
  /** Set only on `confirmed`. */
  confirmed?: RankedHypothesis;
  hypotheses: TrackedHypothesis[];
  evidence: NormalizedObservation[];
  trace: TraceEntry[];
  stats: {
    moves: number;
    toolCalls: number;
    tokensSpent: number;
    strikes: number;
    depth: number;
    elapsedMs: number;
  };
}

/** Absolute backstop on move count — far above any real run; catches a runaway decide-fn. */
const MAX_MOVES = 1000;
/** Consecutive non-productive moves (no new evidence / hypotheses, rejected conclude) → inconclusive. */
const MAX_STALL = 8;

/**
 * Run the orchestrator loop. Pure control flow over injected dependencies:
 * deterministic given a deterministic `decideMove`. Never throws on a bad move
 * (unknown / out-of-range targets are traced and skipped), so a confused LLM
 * degrades to `inconclusive`/`exhausted` rather than crashing.
 */
export async function runOrchestrator(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const now = deps.now ?? Date.now;
  const estimate = deps.estimateTokens ?? (() => 0);
  const start = now();

  const hypotheses: TrackedHypothesis[] = [];
  const evidence: NormalizedObservation[] = [];
  const trace: TraceEntry[] = [];
  let depth = 0;
  let strikes = 0;
  let tokensSpent = 0;
  let toolCalls = 0;
  let moves = 0;
  let stall = 0;

  const record = (entry: TraceEntry): void => {
    trace.push(entry);
    deps.onStep?.(entry);
  };

  const elapsed = (): number => now() - start;

  const finish = (outcome: OrchestratorOutcome, confirmed?: RankedHypothesis): OrchestratorResult => ({
    outcome,
    confirmed,
    hypotheses,
    evidence,
    trace,
    stats: { moves, toolCalls, tokensSpent, strikes, depth, elapsedMs: elapsed() },
  });

  while (moves < MAX_MOVES) {
    // Guards are checked BEFORE spending the next move so a tripped limit never
    // does "one more" expensive thing.
    if (tokensSpent >= deps.guards.maxTokens) return finish("budget-exhausted");
    if (toolCalls >= deps.guards.maxToolCalls) return finish("tool-cap");
    if (elapsed() >= deps.guards.wallClockMs) return finish("wall-clock");
    // strikes → operator pause: the design's headline safety feature. The signal
    // is ambiguous (N hypotheses failed, nothing discriminating emerged); rather
    // than guess, stop and hand the call to a human.
    if (strikes >= deps.guards.maxStrikes) return finish("operator-pause");
    if (stall >= MAX_STALL) return finish("inconclusive");

    const state: OrchestratorState = {
      hypotheses,
      evidence,
      depth,
      strikes,
      tokensSpent,
      toolCalls,
      elapsedMs: elapsed(),
      trace,
    };

    const move = await deps.decideMove(state);
    if (move === null) return finish("exhausted");
    moves++;
    tokensSpent += Math.max(0, estimate(move));

    switch (move.type) {
      case "hypothesize": {
        hypotheses.push({ hypothesis: move.hypothesis, standing: "open" });
        record({ move: "hypothesize", detail: move.hypothesis.hypothesis });
        stall = 0;
        break;
      }
      case "query": {
        const h = hypotheses[move.target];
        if (!h) {
          record({ move: "query", detail: `no hypothesis at index ${move.target} — skipped` });
          stall++;
          break;
        }
        const before = evidence.length;
        const obs = await deps.gatherEvidence(h.hypothesis);
        evidence.push(...obs);
        toolCalls++;
        record({ move: "query", detail: `${h.hypothesis.hypothesis} → +${obs.length} observations` });
        stall = evidence.length > before ? 0 : stall + 1;
        break;
      }
      case "test": {
        const h = hypotheses[move.target];
        if (!h) {
          record({ move: "test", detail: `no hypothesis at index ${move.target} — skipped` });
          stall++;
          break;
        }
        const verdict = deps.evaluate(h.hypothesis.prediction as HypothesisPrediction, evidence);
        h.lastVerdict = verdict;
        if (verdict === "satisfied") {
          h.standing = "confirmed";
          strikes = 0;
        } else {
          h.standing = "ruled-out";
          strikes++;
        }
        record({ move: "test", detail: h.hypothesis.hypothesis, verdict });
        stall = 0;
        break;
      }
      case "conclude": {
        const lead = hypotheses[move.leading];
        // HYBRID STOP: stop only on deterministic confirmation. Self-reported
        // confidence is recorded for the trace but is never the gate.
        if (lead && lead.standing === "confirmed" && lead.lastVerdict === "satisfied") {
          record({ move: "conclude", detail: `confirmed: ${lead.hypothesis.hypothesis}` });
          return finish("confirmed", lead.hypothesis);
        }
        record({
          move: "conclude",
          detail: `rejected — self-confidence ${move.confidence} not backed by the keystone; continuing`,
        });
        stall++;
        break;
      }
      case "spawn-subagent": {
        record({ move: "spawn-subagent", detail: `${move.service}: ${move.question} — deferred (v1)` });
        stall++;
        break;
      }
      case "follow-cause": {
        record({ move: "follow-cause", detail: `${move.service} — deferred (v1)` });
        stall++;
        break;
      }
    }
  }

  return finish("inconclusive");
}

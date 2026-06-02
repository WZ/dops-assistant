/**
 * Hypothesis loop orchestrator — the deterministic control flow that wraps the
 * discriminating-corroboration keystone (./corroboration.ts).
 *
 * Pure and side-effect-free: evidence gathering is injected as a callback, so
 * the entire rank → test → assess → rule-out control flow is unit-testable
 * without an LLM or MCP. The agent/tool glue that supplies `gatherEvidence`
 * lives in the synthesis step and is the only part that needs live validation.
 *
 * Behaviour:
 *   round 1..maxRounds:
 *     - test the current leader: gather discriminating evidence for it
 *     - assessDiscrimination(leader, runnerUp, evidence)
 *       - confirmed    → stop, return confirmed
 *       - undetermined → stop (leader + runner-up both satisfied; report both,
 *                        surface deep mode) — never false-confirm
 *       - weakened     → rule the leader out, promote the next hypothesis
 *   ran out of hypotheses or rounds → "exhausted" (no confirmed cause)
 */

import {
  assessDiscrimination,
  type RankedHypothesis,
  type NormalizedObservation,
  type CorroborationContext,
  type Verdict,
} from "./corroboration.js";

export interface LoopRound {
  round: number;
  testedHypothesis: string;
  leaderVerdict: Verdict;
  runnerUpVerdict?: Verdict;
  outcome: "confirmed" | "undetermined" | "weakened";
}

export interface RuledOutEntry {
  hypothesis: string;
  /** Why it was ruled out — the deterministic verdict that demoted it. */
  reason: Verdict;
}

export interface LoopResult {
  /** The hypothesis confirmed by discriminating evidence, if any. */
  confirmedHypothesis?: RankedHypothesis;
  /** Hypotheses tested and ruled out, with the verdict that demoted each. */
  ruledOut: RuledOutEntry[];
  /** Per-round trace for the report / debugging. */
  rounds: LoopRound[];
  /**
   * - "confirmed":    a hypothesis was confirmed AND distinguished
   * - "undetermined": leader + runner-up both satisfied (correlational tie) →
   *                   caller should surface the deep-mode CTA
   * - "exhausted":    rounds/hypotheses ran out without a confirmed cause
   */
  outcome: "confirmed" | "undetermined" | "exhausted";
  /** Observations accumulated across all test rounds (for receipts). */
  observations: NormalizedObservation[];
}

export interface HypothesisLoopOptions {
  /** Ranked hypotheses, leader first, each with a structured prediction. */
  hypotheses: RankedHypothesis[];
  /** Max test rounds. <=1 means the loop does not run (caller uses single-pass). */
  maxRounds: number;
  /** Evidence already gathered before the loop (the parallel evidence phase). */
  initialObservations: NormalizedObservation[];
  /**
   * Gather discriminating evidence for the leading hypothesis in a given round
   * (the read-only re-query). Injected so the control flow stays pure/testable.
   * Returning [] is fine — the loop just re-assesses on existing evidence.
   */
  gatherEvidence: (leader: RankedHypothesis, round: number) => Promise<NormalizedObservation[]>;
  ctx?: CorroborationContext;
  /**
   * Live progress hook — fired as the loop ranks, tests, and rules out, so the
   * caller can surface a "Testing hypotheses" feed in the UI while investigating.
   * Optional + side-effect-only: omitting it leaves the loop pure/deterministic.
   */
  onRound?: (ev: LoopProgressEvent) => void;
}

/** A single live-progress beat from the loop, for UI surfacing. */
export interface LoopProgressEvent {
  /** ranking = before any test; testing = about to test the leader; verdict = result is in. */
  phase: "ranking" | "testing" | "verdict";
  round: number;
  maxRounds: number;
  hypothesis?: string;
  /** Number of ranked candidates (ranking phase only). */
  count?: number;
  outcome?: "confirmed" | "undetermined" | "weakened";
  verdict?: Verdict;
}

/**
 * Run the bounded hypothesis loop. Deterministic given the same inputs +
 * gatherEvidence results.
 */
export async function runHypothesisLoop(opts: HypothesisLoopOptions): Promise<LoopResult> {
  const ctx = opts.ctx ?? {};
  const ranked = [...opts.hypotheses];
  const ruledOut: RuledOutEntry[] = [];
  const rounds: LoopRound[] = [];
  const observations: NormalizedObservation[] = [...opts.initialObservations];

  const maxRounds = Math.max(1, opts.maxRounds);
  opts.onRound?.({ phase: "ranking", round: 0, maxRounds, count: ranked.length });

  for (let round = 1; round <= maxRounds; round++) {
    const leader = ranked[0];
    if (!leader) break; // ran out of hypotheses to test
    const runnerUp = ranked[1];

    opts.onRound?.({ phase: "testing", round, maxRounds, hypothesis: leader.hypothesis });

    // Test the leader: gather discriminating evidence (read-only re-query).
    const fresh = await opts.gatherEvidence(leader, round);
    if (fresh.length) observations.push(...fresh);

    const r = assessDiscrimination(leader, runnerUp, observations, ctx);
    rounds.push({
      round,
      testedHypothesis: leader.hypothesis,
      leaderVerdict: r.leaderVerdict,
      runnerUpVerdict: r.runnerUpVerdict,
      outcome: r.outcome,
    });
    opts.onRound?.({ phase: "verdict", round, maxRounds, hypothesis: leader.hypothesis, outcome: r.outcome, verdict: r.leaderVerdict });

    if (r.outcome === "confirmed") {
      return { confirmedHypothesis: leader, ruledOut, rounds, outcome: "confirmed", observations };
    }
    if (r.outcome === "undetermined") {
      // Correlational tie — do not false-confirm. Stop and let the caller
      // surface deep mode.
      return { ruledOut, rounds, outcome: "undetermined", observations };
    }

    // weakened → rule the leader out and promote the next hypothesis.
    ruledOut.push({ hypothesis: leader.hypothesis, reason: r.leaderVerdict });
    ranked.shift();
  }

  return { ruledOut, rounds, outcome: "exhausted", observations };
}

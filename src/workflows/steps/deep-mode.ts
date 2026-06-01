/**
 * Deep mode (Step 3) — the user-triggered, skeptical re-examination pass.
 *
 * The bounded hypothesis loop (Step 2) is deliberately quick: it rules a
 * hypothesis out the moment its prediction isn't satisfied by the evidence
 * already on hand. That's the right default, but thin evidence can rule out a
 * REAL cause (a metric the broad pass never queried, a log window it didn't
 * scan). Deep mode is the opt-in second look: for the top ruled-out
 * hypotheses, it gathers DEEPER evidence (more aggressive re-query — broader
 * windows, cross-service, higher budget) and re-evaluates the SAME structured
 * prediction with the SAME deterministic keystone (./corroboration.ts).
 *
 * The framing is skeptical-of-the-rule-out: try hard to RESURRECT each
 * dismissed cause. If deeper evidence now satisfies its prediction, the loop
 * gave up too early → surface it as a candidate again. If it still doesn't
 * satisfy, the rule-out is confirmed — which strengthens trust in the loop's
 * original conclusion rather than just spending tokens.
 *
 * Pure and side-effect-free: `gatherDeepEvidence` is injected, so the whole
 * re-examination control flow is unit-testable without an LLM or MCP. The
 * agent/tool glue lives in the trigger/runner layer.
 *
 * Read-only by construction: it only issues verification queries (same
 * contract as the loop's re-query) and never mutates.
 */

import {
  evaluatePrediction,
  type RankedHypothesis,
  type HypothesisPrediction,
  type NormalizedObservation,
  type CorroborationContext,
  type Verdict,
} from "./corroboration.js";

export interface ReexaminedHypothesis {
  hypothesis: string;
  /** Verdict the loop reached (why it was ruled out): "weakened"/"absent". */
  priorVerdict: Verdict;
  /** Verdict after deeper evidence was gathered. */
  deepVerdict: Verdict;
  /** Deeper evidence flipped a non-satisfied prediction to satisfied. */
  resurrected: boolean;
  /** Count of fresh observations the deep re-query added for this hypothesis. */
  deepEvidenceCount: number;
}

export interface DeepModeResult {
  /** Per-hypothesis re-examination trace (top-N, leader-first). */
  reexamined: ReexaminedHypothesis[];
  /** Hypotheses whose prediction newly satisfied under deeper evidence. */
  resurrected: RankedHypothesis[];
  /** All observations after the deep re-queries (prior + fresh), for receipts. */
  observations: NormalizedObservation[];
  /**
   * - "resurrected-candidate": at least one ruled-out cause came back → the
   *   single-pass/loop conclusion is suspect; report the resurrected cause(s).
   * - "rule-outs-confirmed": deeper evidence still doesn't support any of them →
   *   the loop's rule-outs hold; this raises confidence rather than changing it.
   * - "nothing-to-examine": no ruled-out hypotheses carried predictions.
   */
  outcome: "resurrected-candidate" | "rule-outs-confirmed" | "nothing-to-examine";
}

export interface DeepModeOptions {
  /**
   * Ruled-out hypotheses to re-examine, leader-first, each WITH its structured
   * prediction (matched back from the loop's original ranked list — the loop's
   * RuledOutEntry only keeps the text + verdict). Already trimmed/ordered by
   * the caller; `maxReexamine` bounds how many are actually re-queried.
   */
  ruledOut: Array<{ hypothesis: RankedHypothesis; priorVerdict: Verdict }>;
  /** Observations the loop already gathered, carried in as the baseline. */
  priorObservations: NormalizedObservation[];
  /** Cap on how many top ruled-out hypotheses to re-examine (bounds cost). */
  maxReexamine: number;
  /**
   * Gather DEEPER evidence for one ruled-out hypothesis (the aggressive,
   * possibly cross-service read-only re-query). Injected so the control flow
   * stays pure/testable. Returning [] is fine — the prediction is then just
   * re-evaluated on prior evidence (usually still not satisfied).
   */
  gatherDeepEvidence: (h: RankedHypothesis) => Promise<NormalizedObservation[]>;
  ctx?: CorroborationContext;
}

/**
 * Widen an incident time window for deep mode's re-query — so it digs into a
 * BROADER span than the loop did, catching precursors/aftermath the narrow
 * synthesis window missed. Expands each side by max(duration, 30min), i.e.
 * roughly triples the window, centered on the incident.
 *
 * Pure + defensive: only widens parseable ISO/epoch ranges. Non-parseable
 * inputs (Grafana relative ranges like "now-1h", or undefined) pass through
 * unchanged — never fabricate a window deep mode can't actually query.
 */
export function widenTimeRange(
  tr: { from: string; to: string } | undefined,
  minPadMs = 30 * 60 * 1000,
): { from: string; to: string } | undefined {
  if (!tr) return tr;
  const from = Date.parse(tr.from);
  const to = Date.parse(tr.to);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return tr;
  const pad = Math.max(to - from, minPadMs);
  return {
    from: new Date(from - pad).toISOString(),
    to: new Date(to + pad).toISOString(),
  };
}

/**
 * Re-examine the top ruled-out hypotheses with deeper evidence. Deterministic
 * given the same inputs + gatherDeepEvidence results.
 */
export async function runDeepMode(opts: DeepModeOptions): Promise<DeepModeResult> {
  const ctx = opts.ctx ?? {};
  const targets = opts.ruledOut.slice(0, Math.max(0, opts.maxReexamine));

  if (targets.length === 0) {
    return {
      reexamined: [],
      resurrected: [],
      observations: [...opts.priorObservations],
      outcome: "nothing-to-examine",
    };
  }

  const observations: NormalizedObservation[] = [...opts.priorObservations];
  const reexamined: ReexaminedHypothesis[] = [];
  const resurrected: RankedHypothesis[] = [];

  for (const { hypothesis, priorVerdict } of targets) {
    const fresh = await opts.gatherDeepEvidence(hypothesis);
    if (fresh.length) observations.push(...fresh);

    // Re-evaluate against the FULL accumulated evidence (prior + every deep
    // re-query so far) so cross-hypothesis evidence is available too.
    const deepVerdict = evaluatePrediction(hypothesis.prediction, observations, ctx);
    const wasResurrected = deepVerdict === "satisfied" && priorVerdict !== "satisfied";

    reexamined.push({
      hypothesis: hypothesis.hypothesis,
      priorVerdict,
      deepVerdict,
      resurrected: wasResurrected,
      deepEvidenceCount: fresh.length,
    });
    if (wasResurrected) resurrected.push(hypothesis);
  }

  return {
    reexamined,
    resurrected,
    observations,
    outcome: resurrected.length > 0 ? "resurrected-candidate" : "rule-outs-confirmed",
  };
}

// ── Reconstructing re-examination targets from a stored report ────────────────

const VERDICTS: ReadonlySet<string> = new Set(["satisfied", "contradicted", "absent"]);

/**
 * Rejoin a stored report's `ruledOut` (text + reason) with its `hypotheses`
 * (text + structured prediction) so deep mode can re-test them. The report
 * keeps the two apart — `ruledOut` carries only the hypothesis text and the
 * verdict that demoted it, while the prediction lives on the matching
 * `hypotheses` entry. Pure: no I/O, exhaustively testable.
 *
 * Ruled-out hypotheses with no matching prediction are dropped (can't re-test a
 * prediction we don't have). The prediction is cast to the typed union — the
 * keystone validates its shape at evaluation time.
 */
export function matchRuledOutToPredictions(
  hypotheses: ReadonlyArray<{ hypothesis: string; prediction: Record<string, unknown> | HypothesisPrediction }>,
  ruledOut: ReadonlyArray<{ hypothesis: string; reason: string }>,
): Array<{ hypothesis: RankedHypothesis; priorVerdict: Verdict }> {
  const predictionByText = new Map(hypotheses.map((h) => [h.hypothesis, h.prediction]));
  const targets: Array<{ hypothesis: RankedHypothesis; priorVerdict: Verdict }> = [];
  for (const r of ruledOut) {
    const prediction = predictionByText.get(r.hypothesis);
    if (!prediction) continue;
    const priorVerdict: Verdict = VERDICTS.has(r.reason) ? (r.reason as Verdict) : "absent";
    targets.push({
      hypothesis: { hypothesis: r.hypothesis, prediction: prediction as HypothesisPrediction },
      priorVerdict,
    });
  }
  return targets;
}

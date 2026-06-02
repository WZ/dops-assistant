/**
 * Deep mode (Step 3) — the user-triggered, skeptical re-examination pass.
 *
 * The bounded hypothesis loop (Step 2) reaches a conclusion quickly. Deep mode
 * is the opt-in second look that gathers DEEPER evidence (a broader re-query
 * window — see widenTimeRange) and re-evaluates the SAME structured predictions
 * with the SAME deterministic keystone (./corroboration.ts). It re-examines the
 * loop's conclusion by STANDING:
 *
 *   - ruled-out causes  → try to RESURRECT them. If deeper evidence now
 *     satisfies a dismissed prediction, the loop gave up too early.
 *   - the confirmed cause → try to REFUTE it. If deeper evidence no longer
 *     satisfies it, the confirmation is shaky ("shaken under scrutiny").
 *
 * Either way the verdict that doesn't flip is itself useful: rule-outs that
 * hold + confirmations that survive raise trust rather than just spend tokens.
 *
 * Pure and side-effect-free: `gatherDeepEvidence` is injected, so the whole
 * control flow is unit-testable without an LLM or MCP. Read-only by
 * construction — it only issues verification queries, never mutates.
 */

import {
  evaluatePrediction,
  type RankedHypothesis,
  type HypothesisPrediction,
  type NormalizedObservation,
  type CorroborationContext,
  type Verdict,
} from "./corroboration.js";

/** How the loop left a hypothesis — deep mode re-tests it from this standing. */
export type PriorStanding = "confirmed" | "ruled-out";

/** A hypothesis to re-examine, with the standing the loop gave it. */
export interface ReexamineTarget {
  hypothesis: RankedHypothesis;
  priorStanding: PriorStanding;
  /** The loop's verdict for it (satisfied for confirmed; weakened/absent for ruled-out). */
  priorVerdict: Verdict;
}

export interface ReexaminedHypothesis {
  hypothesis: string;
  priorStanding: PriorStanding;
  priorVerdict: Verdict;
  /** Verdict after deeper evidence was gathered. */
  deepVerdict: Verdict;
  /**
   * The standing changed under deeper evidence:
   *   ruled-out → satisfied  (resurrected), or
   *   confirmed → not satisfied (shaken).
   */
  flipped: boolean;
  /** Count of fresh observations the deep re-query added for this hypothesis. */
  deepEvidenceCount: number;
}

export interface DeepModeResult {
  /** Per-hypothesis re-examination trace (top-N, leader-first). */
  reexamined: ReexaminedHypothesis[];
  /** Ruled-out hypotheses that deeper evidence brought back. */
  resurrected: RankedHypothesis[];
  /** Confirmed hypotheses that deeper evidence no longer supports. */
  shaken: RankedHypothesis[];
  /** All observations after the deep re-queries (prior + fresh), for receipts. */
  observations: NormalizedObservation[];
  /**
   * - "resurrected-candidate": a ruled-out cause came back → the conclusion is
   *   likely incomplete; report the resurrected cause(s).
   * - "confirmation-shaken": the confirmed cause no longer holds under deeper
   *   evidence → the conclusion is suspect.
   * - "holds": nothing flipped — rule-outs held / the confirmation survived.
   *   Strengthens trust in the loop's conclusion.
   * - "nothing-to-examine": no re-examinable hypotheses (single-pass / empty).
   */
  outcome: "resurrected-candidate" | "confirmation-shaken" | "holds" | "nothing-to-examine";
}

export interface DeepModeOptions {
  /** Hypotheses to re-examine, leader-first, each WITH its prior standing. */
  targets: ReexamineTarget[];
  /** Observations the loop already gathered, carried in as the baseline. */
  priorObservations: NormalizedObservation[];
  /** Cap on how many targets to re-examine (bounds cost). */
  maxReexamine: number;
  /**
   * Gather DEEPER evidence for one hypothesis (the aggressive read-only
   * re-query over a wider window). Injected so the control flow stays
   * pure/testable. Returning [] is fine — the prediction is then re-evaluated
   * on prior evidence.
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
 * Re-examine the targets with deeper evidence. Deterministic given the same
 * inputs + gatherDeepEvidence results.
 */
export async function runDeepMode(opts: DeepModeOptions): Promise<DeepModeResult> {
  const ctx = opts.ctx ?? {};
  const targets = opts.targets.slice(0, Math.max(0, opts.maxReexamine));

  if (targets.length === 0) {
    return { reexamined: [], resurrected: [], shaken: [], observations: [...opts.priorObservations], outcome: "nothing-to-examine" };
  }

  const observations: NormalizedObservation[] = [...opts.priorObservations];
  const reexamined: ReexaminedHypothesis[] = [];
  const resurrected: RankedHypothesis[] = [];
  const shaken: RankedHypothesis[] = [];

  for (const { hypothesis, priorStanding, priorVerdict } of targets) {
    const fresh = await opts.gatherDeepEvidence(hypothesis);
    if (fresh.length) observations.push(...fresh);

    // Re-evaluate against the FULL accumulated evidence (prior + every deep
    // re-query so far) so cross-hypothesis evidence is available too.
    const deepVerdict = evaluatePrediction(hypothesis.prediction, observations, ctx);
    // ruled-out flips UP (resurrected) when it now satisfies; confirmed flips
    // DOWN (shaken) when it no longer satisfies.
    const flipped =
      priorStanding === "ruled-out"
        ? deepVerdict === "satisfied" && priorVerdict !== "satisfied"
        : deepVerdict !== "satisfied";

    reexamined.push({ hypothesis: hypothesis.hypothesis, priorStanding, priorVerdict, deepVerdict, flipped, deepEvidenceCount: fresh.length });
    if (flipped && priorStanding === "ruled-out") resurrected.push(hypothesis);
    if (flipped && priorStanding === "confirmed") shaken.push(hypothesis);
  }

  const outcome = resurrected.length > 0
    ? "resurrected-candidate"
    : shaken.length > 0
      ? "confirmation-shaken"
      : "holds";

  return { reexamined, resurrected, shaken, observations, outcome };
}

// ── Reconstructing re-examination targets from a stored report ────────────────

const VERDICTS: ReadonlySet<string> = new Set(["satisfied", "contradicted", "absent"]);

type StoredHypothesis = { hypothesis: string; prediction: Record<string, unknown> | HypothesisPrediction };

/**
 * Rejoin a stored report's `ruledOut` (text + reason) with its `hypotheses`
 * (text + structured prediction). The report keeps the two apart; the
 * prediction lives on the matching `hypotheses` entry. Ruled-out hypotheses
 * with no matching prediction are dropped (can't re-test what we don't have).
 */
export function matchRuledOutToPredictions(
  hypotheses: ReadonlyArray<StoredHypothesis>,
  ruledOut: ReadonlyArray<{ hypothesis: string; reason: string }>,
): Array<{ hypothesis: RankedHypothesis; priorVerdict: Verdict }> {
  const predictionByText = new Map(hypotheses.map((h) => [h.hypothesis, h.prediction]));
  const targets: Array<{ hypothesis: RankedHypothesis; priorVerdict: Verdict }> = [];
  for (const r of ruledOut) {
    const prediction = predictionByText.get(r.hypothesis);
    if (!prediction) continue;
    const priorVerdict: Verdict = VERDICTS.has(r.reason) ? (r.reason as Verdict) : "absent";
    targets.push({ hypothesis: { hypothesis: r.hypothesis, prediction: prediction as HypothesisPrediction }, priorVerdict });
  }
  return targets;
}

/**
 * Build the re-examination targets from a completed report:
 *   - if the loop ruled causes out → RESURRECT mode (re-test the rule-outs);
 *   - else if it confirmed / was undetermined → REFUTE mode (skeptically
 *     re-test the standing conclusion: the leader, or the tied top-2).
 * Returns [] for single-pass reports (no hypotheses) — nothing to re-examine.
 */
export function buildReexamineTargets(
  hypotheses: ReadonlyArray<StoredHypothesis>,
  ruledOut: ReadonlyArray<{ hypothesis: string; reason: string }>,
  loopOutcome: string | undefined,
  maxReexamine: number,
): ReexamineTarget[] {
  const ruled = matchRuledOutToPredictions(hypotheses, ruledOut).map(
    (t): ReexamineTarget => ({ ...t, priorStanding: "ruled-out" }),
  );
  if (ruled.length > 0) return ruled.slice(0, maxReexamine);

  // No rule-outs: skeptically re-test the loop's standing conclusion.
  if (loopOutcome === "confirmed" || loopOutcome === "undetermined") {
    const topN = loopOutcome === "undetermined" ? 2 : 1;
    return hypotheses
      .filter((h) => h && typeof h.hypothesis === "string")
      .slice(0, topN)
      .map((h): ReexamineTarget => ({
        hypothesis: { hypothesis: h.hypothesis, prediction: h.prediction as HypothesisPrediction },
        priorStanding: "confirmed",
        priorVerdict: "satisfied",
      }))
      .slice(0, maxReexamine);
  }
  return [];
}

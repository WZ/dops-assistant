/**
 * Discriminating corroboration — the keystone of the hypothesis loop.
 *
 * The loop's stop signal must be DETERMINISTIC (not the LLM's self-reported
 * confidence) and DISCRIMINATING (ops evidence is correlational — a deploy,
 * error spike, and pod restart all happen at incident time and "confirm"
 * several hypotheses at once; a query that confirms the leader but would also
 * confirm the runner-up proves nothing).
 *
 * To make corroboration checkable, each hypothesis carries a structured
 * `HypothesisPrediction` — a typed, falsifiable expectation about an observable.
 * `evaluatePrediction` checks a prediction against the gathered observations and
 * returns satisfied / contradicted / absent. `assessDiscrimination` then decides
 * whether the leading hypothesis is *confirmed AND distinguished* from its
 * runner-up.
 *
 * SPIKE STATUS: this proves the mechanism on representative incident shapes.
 * The open real-world question — can the LLM reliably emit these structured
 * predictions, and do real incidents admit a discriminating one? — needs
 * validation against labeled incidents. Until then the loop ships behind N=1
 * (current single-pass behavior) and this module is exercised only in tests.
 */

// ── Normalized observation (subset of the per-phase evidence shapes) ──────────

export interface NormalizedObservation {
  phase: "metrics" | "logs" | "infra" | "changes";
  /** metric name / log pattern / resource / change title — the thing observed */
  subject: string;
  /** parsed numeric value when the observation carries one (metric currentValue) */
  value?: number;
  /** free-text status/detail/sample for substring checks (log sample, infra status) */
  text?: string;
  /** ISO timestamp when the observation carries one (infra event, change/deploy) */
  timestamp?: string;
}

// ── Structured, checkable predictions ────────────────────────────────────────

export type HypothesisPrediction =
  /** A metric crosses a threshold, e.g. payments p99 > 5 (seconds). */
  | { kind: "metric-threshold"; metric: string; op: ">" | "<" | ">=" | "<="; value: number }
  /** A log pattern is present (or, with present:false, absent). */
  | { kind: "log-pattern"; pattern: string; present?: boolean }
  /** An infra resource is in a given status, e.g. checkout-api OOMKilled. */
  | { kind: "infra-status"; resource?: string; status: string }
  /** A change (deploy/MR) landed within N minutes before the incident. */
  | { kind: "change-in-window"; withinMinutesBefore: number };

export type Verdict = "satisfied" | "contradicted" | "absent";

export interface CorroborationContext {
  /** Incident onset (anomaly window start), ISO. Used by change-in-window. */
  incidentTime?: string;
}

const normalize = (s: string): string => s.toLowerCase().trim();

/** Parse a metric value string like "8.0s", "1.2k", "503", "95%" to a number. */
export function parseMetricValue(raw: string | number | undefined): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const m = raw.match(/-?\d+(?:\.\d+)?/);
  if (!m) return undefined;
  let n = parseFloat(m[0]);
  if (Number.isNaN(n)) return undefined;
  const lower = raw.toLowerCase();
  if (/\bk\b|k\s*$|thousand/.test(lower)) n *= 1e3;
  else if (/\bm\b|m\s*$|million/.test(lower)) n *= 1e6;
  return n;
}

function cmp(value: number, op: ">" | "<" | ">=" | "<=", target: number): boolean {
  switch (op) {
    case ">": return value > target;
    case "<": return value < target;
    case ">=": return value >= target;
    case "<=": return value <= target;
    default: return false;
  }
}

/**
 * Evaluate one structured prediction against the observations.
 * - satisfied:    an observation matches the prediction
 * - contradicted: an observation directly refutes it (e.g. metric below the
 *                 threshold it was predicted to exceed, or a pattern expected
 *                 present is provably absent only when present:false)
 * - absent:       no observation speaks to the prediction either way
 */
export function evaluatePrediction(
  prediction: HypothesisPrediction,
  observations: NormalizedObservation[],
  ctx: CorroborationContext = {},
): Verdict {
  switch (prediction.kind) {
    case "metric-threshold": {
      const want = normalize(prediction.metric);
      const matches = observations.filter(
        (o) => o.phase === "metrics" && o.value !== undefined && normalize(o.subject).includes(want),
      );
      if (matches.length === 0) return "absent";
      // Satisfied if ANY matching metric crosses the threshold; contradicted if
      // a matching metric exists but none cross it.
      const satisfied = matches.some((o) => cmp(o.value!, prediction.op, prediction.value));
      return satisfied ? "satisfied" : "contradicted";
    }
    case "log-pattern": {
      const want = normalize(prediction.pattern);
      const present = observations.some(
        (o) => o.phase === "logs" && (normalize(o.subject).includes(want) || normalize(o.text ?? "").includes(want)),
      );
      const expectPresent = prediction.present !== false;
      if (expectPresent) return present ? "satisfied" : "absent";
      // present:false → predicting absence. Satisfied only if we have logs and
      // the pattern is not among them; absent if we have no logs to judge.
      const haveLogs = observations.some((o) => o.phase === "logs");
      if (!haveLogs) return "absent";
      return present ? "contradicted" : "satisfied";
    }
    case "infra-status": {
      const wantStatus = normalize(prediction.status);
      const wantResource = prediction.resource ? normalize(prediction.resource) : undefined;
      const matches = observations.filter((o) => {
        if (o.phase !== "infra") return false;
        if (wantResource && !normalize(o.subject).includes(wantResource)) return false;
        return normalize(o.text ?? "").includes(wantStatus) || normalize(o.subject).includes(wantStatus);
      });
      return matches.length > 0 ? "satisfied" : "absent";
    }
    case "change-in-window": {
      const changes = observations.filter((o) => o.phase === "changes" && o.timestamp);
      if (changes.length === 0) return "absent";
      if (!ctx.incidentTime) return "absent";
      const incidentMs = Date.parse(ctx.incidentTime);
      if (Number.isNaN(incidentMs)) return "absent";
      const windowMs = prediction.withinMinutesBefore * 60_000;
      const inWindow = changes.some((o) => {
        const t = Date.parse(o.timestamp!);
        if (Number.isNaN(t)) return false;
        const delta = incidentMs - t; // positive = change before incident
        return delta >= 0 && delta <= windowMs;
      });
      return inWindow ? "satisfied" : "contradicted";
    }
    default:
      return "absent";
  }
}

// ── Discrimination assessment (the stop signal) ──────────────────────────────

export interface RankedHypothesis {
  hypothesis: string;
  prediction: HypothesisPrediction;
}

export interface DiscriminationResult {
  /** The leader's prediction is satisfied by the evidence. */
  confirmed: boolean;
  /** Confirmed AND the same evidence does NOT equally satisfy the runner-up. */
  discriminating: boolean;
  leaderVerdict: Verdict;
  runnerUpVerdict?: Verdict;
  /**
   * Outcome the loop acts on:
   * - "confirmed":      stop — leader confirmed and distinguished
   * - "undetermined":   leader + runner-up both satisfied (correlational tie) →
   *                     report both, surface the deep-mode CTA
   * - "weakened":       leader not satisfied → demote, test the next hypothesis
   */
  outcome: "confirmed" | "undetermined" | "weakened";
}

/**
 * Decide whether the leading hypothesis is confirmed and distinguished from the
 * runner-up, given the current observations. This is the loop's deterministic,
 * discriminating stop signal — it never consults the LLM's confidenceScore.
 */
export function assessDiscrimination(
  leader: RankedHypothesis,
  runnerUp: RankedHypothesis | undefined,
  observations: NormalizedObservation[],
  ctx: CorroborationContext = {},
): DiscriminationResult {
  const leaderVerdict = evaluatePrediction(leader.prediction, observations, ctx);
  const confirmed = leaderVerdict === "satisfied";

  if (!confirmed) {
    return { confirmed: false, discriminating: false, leaderVerdict, outcome: "weakened" };
  }

  if (!runnerUp) {
    // Nothing to distinguish from — a confirmed sole hypothesis is decisive.
    return { confirmed: true, discriminating: true, leaderVerdict, outcome: "confirmed" };
  }

  const runnerUpVerdict = evaluatePrediction(runnerUp.prediction, observations, ctx);
  const discriminating = runnerUpVerdict !== "satisfied";
  return {
    confirmed: true,
    discriminating,
    leaderVerdict,
    runnerUpVerdict,
    outcome: discriminating ? "confirmed" : "undetermined",
  };
}

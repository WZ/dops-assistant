// ── Structured observation types ─────────────────────────────────────────────

export type MetricObservation = {
  metric: string;
  currentValue: string;
  baselineValue: string;
  timestamp: string;
  severity: "normal" | "warning" | "critical";
};

export type MetricFindings = {
  observations: MetricObservation[];
  anomalyWindow: string;
  summary: string;
};

export type LogObservation = {
  pattern: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  sample: string;
  sampleLines: string[];
};

export type LogFindings = {
  observations: LogObservation[];
  summary: string;
};

export type InfraObservation = {
  resource: string;
  status: string;
  detail: string;
  timestamp: string;
};

export type InfraFindings = {
  observations: InfraObservation[];
  summary: string;
};

// ── Phase types ──────────────────────────────────────────────────────────────

export type InvestigationPlan = {
  hypotheses: Array<{ hypothesis: string; evidenceNeeded: string }>;
  metricFocus: string[];
  logFocus: string[];
  infraFocus: string[];
};

// ── Report types ─────────────────────────────────────────────────────────────

export type TimelineEvent = {
  time: string;
  event: string;
};

/** A single tool call captured during an evidence phase. Mirrors
 *  `ToolCallRecordSchema` in `src/workflows/schemas.ts`. Used to build
 *  observation-level Grafana deep links in the web UI. */
export type EvidenceToolCall = {
  tool: string;
  args: string;
  resultChars: number;
  /** Short snippet of the actual tool result, shown inline in receipts so the
   *  operator sees the value without clicking through to Grafana. */
  resultExcerpt?: string;
};

/** A candidate root cause the hypothesis loop ranked (Step 2). Mirrors
 *  RankedHypothesisSchema in src/workflows/schemas.ts. */
export type RankedHypothesis = {
  hypothesis: string;
  prediction: Record<string, unknown>;
};

/** A hypothesis the loop tested and ruled out, with the deterministic verdict
 *  ("contradicted" | "absent") that demoted it. */
export type RuledOutHypothesis = {
  hypothesis: string;
  reason: string;
};

/** One hypothesis re-examined by deep mode (Step 3). Mirrors
 *  ReexaminedHypothesis in src/workflows/steps/deep-mode.ts. */
export type DeepModeReexamination = {
  hypothesis: string;
  /** How the loop left it: confirmed (re-tested to refute) or ruled-out (to resurrect). */
  priorStanding: "confirmed" | "ruled-out";
  /** The loop's verdict for it. */
  priorVerdict: "satisfied" | "contradicted" | "absent";
  /** Verdict after deep mode gathered deeper evidence. */
  deepVerdict: "satisfied" | "contradicted" | "absent";
  /** Standing changed: ruled-out→satisfied (resurrected) or confirmed→not-satisfied (shaken). */
  flipped: boolean;
};

/** Deep-mode output (Step 3): the skeptical re-examination of the loop's
 *  conclusion. Unset unless deep mode was triggered. */
export type DeepModeReport = {
  reexamined: DeepModeReexamination[];
  /** Ruled-out hypotheses deeper evidence brought back as live candidates. */
  resurrected: RankedHypothesis[];
  /** Confirmed hypotheses deeper evidence no longer supports. */
  shaken: RankedHypothesis[];
  outcome: "resurrected-candidate" | "confirmation-shaken" | "holds" | "nothing-to-examine";
  examinedAt: string;
};

export type RcaReport = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  impact: {
    duration: string;
    description: string;
  };
  trigger: string;
  rootCause: string;
  contributingFactors: string[];
  timeline: TimelineEvent[];
  evidence: {
    metrics: string[];
    logs: string[];
    infra: string[];
    changes?: string[];
  };
  dashboardLinks: string[];
  recommendedActions: string[];
  confidence: "low" | "medium" | "high";
  confidenceScore: number;
  investigatedAt: string;
  skillsUsed?: string[];
  timeRange?: { from: string; to: string };
  /** Tool calls captured per evidence phase (keyed by phase: metrics/logs/infra/changes).
   *  Carried through from the workflow so the UI can build observation-level
   *  Grafana deep links. */
  evidenceToolCalls?: Record<string, EvidenceToolCall[]>;
  /** Hypothesis-loop output (Step 2). Unset on the default single-pass path. */
  hypotheses?: RankedHypothesis[];
  ruledOut?: RuledOutHypothesis[];
  loopOutcome?: "confirmed" | "undetermined" | "exhausted";
  /** Deep-mode re-examination (Step 3). Set only when deep mode was triggered. */
  deepMode?: DeepModeReport;
};

export type InvestigationIntent =
  | { intent: "investigation"; service?: string }
  | { intent: "question" };

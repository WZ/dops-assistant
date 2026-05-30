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
};

export type InvestigationIntent =
  | { intent: "investigation"; service?: string }
  | { intent: "question" };

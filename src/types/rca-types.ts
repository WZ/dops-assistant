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

/** Structured remediation link — emitted alongside prose recommendedActions when
 *  the agent has a concrete command or URL to offer. Non-executable: the UI
 *  exposes copy-to-clipboard and click-through only. */
export type ActionLink = {
  label: string;
  rationale?: string;
  command?: string;
  url?: string;
  urlLabel?: string;
  kind?: "rollback" | "scale" | "restart" | "config" | "investigate" | "other";
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
  /** Structured remediation links emitted alongside prose actions when the agent
   *  has a grounded command or URL. Optional — unset for older reports. */
  actionLinks?: ActionLink[];
  confidence: "low" | "medium" | "high";
  confidenceScore: number;
  investigatedAt: string;
  skillsUsed?: string[];
  timeRange?: { from: string; to: string };
};

export type InvestigationIntent =
  | { intent: "investigation"; service?: string }
  | { intent: "question" };

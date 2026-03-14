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

export type ReflectionResult = {
  validationNotes: string;
  revisedRootCause: string;
  revisedTrigger: string;
  revisedSeverity: "low" | "medium" | "high" | "critical";
  revisedConfidence: "low" | "medium" | "high";
  revisedConfidenceScore: number;
  revisedSummary: string;
  issues: string[];
};

// ── Report types ─────────────────────────────────────────────────────────────

export type TimelineEvent = {
  time: string;
  event: string;
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
  };
  dashboardLinks: string[];
  recommendedActions: string[];
  confidence: "low" | "medium" | "high";
  confidenceScore: number;
  investigatedAt: string;
  skillsUsed?: string[];
};

export type InvestigationIntent =
  | { intent: "investigation"; service?: string }
  | { intent: "question" };

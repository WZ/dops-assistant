import type { PanelImage } from "../mcp/client.js";

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
  revisedSeverity: "low" | "medium" | "high" | "critical";
  revisedConfidence: "low" | "medium" | "high";
  revisedSummary: string;
  issues: string[];
};

// ── Report types ─────────────────────────────────────────────────────────────

export type RcaReport = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  rootCause: string;
  evidence: {
    metrics: string[];
    logs: string[];
    infra: string[];
  };
  dashboardLinks: string[];
  panelImages: PanelImage[];
  recommendedActions: string[];
  confidence: "low" | "medium" | "high";
  investigatedAt: string;
};

export type InvestigationIntent =
  | { intent: "investigation"; service?: string }
  | { intent: "question" };

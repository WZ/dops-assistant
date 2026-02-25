export type MetricFindings = {
  observations: string[];  // key metric values with timestamps
  baseline: string;        // normal range for comparison
  anomalyWindow: string;   // when the anomaly started
};

export type LogFindings = {
  errorPatterns: string[];  // recurring error messages
  stackTraces: string[];    // relevant stack traces
  firstOccurrence: string;  // ISO timestamp or "unknown"
};

export type InfraFindings = {
  podHealth: string[];    // restarts, OOMKilled, CrashLoopBackOff
  nodeHealth: string[];   // CPU/memory pressure
  recentEvents: string[]; // k8s events, alerts
};

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
  recommendedActions: string[];
  confidence: "low" | "medium" | "high";
  investigatedAt: string;
};

export type InvestigationIntent =
  | { intent: "investigation"; service?: string }
  | { intent: "question" };

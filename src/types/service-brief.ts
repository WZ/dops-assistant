// ── Service Brief types ───────────────────────────────────────────────────────
// Used by the Service Detail Overview tab (GET /api/services/:name/brief).

/**
 * A node in the service dependency graph.
 * Extends the DependencyNode concept from routes.ts with an explicit "unknown"
 * status value so the UI can distinguish "not yet fetched" from "healthy".
 */
export interface BriefDependencyNode {
  id: string;
  name: string;
  type: "service" | "database" | "queue" | "cache" | "external";
  /** "unhealthy" matches the existing vocabulary in routes.ts (not "down"). */
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
}

/**
 * A directed edge in the service dependency graph.
 * requestRate / errorRate are Phase 2 additions — optional from day one.
 */
export interface BriefDependencyEdge {
  source: string;
  target: string;
  label?: string;
  /** Phase 2: requests per second on this edge. */
  requestRate?: number;
  /** Phase 2: error rate (0–1) on this edge. */
  errorRate?: number;
}

// ── Changes section ───────────────────────────────────────────────────────────

/** A GitLab pipeline deployment. */
export interface Deployment {
  ref: string;
  pipelineId: number;
  /**
   * GitLab pipeline status string.
   * Known values: "success", "failed", "running", "pending", "canceled",
   * "skipped", "manual", "scheduled", "created", "waiting_for_resource",
   * "preparing", "blocked".
   */
  pipelineStatus: string;
  environment: string;
  /** ISO 8601 timestamp. */
  deployedAt: string;
  deployedBy: string;
}

/** A merged GitLab merge request. */
export interface MergeRequest {
  iid: number;
  title: string;
  /** ISO 8601 timestamp. */
  mergedAt: string;
  mergedBy: string;
  filesChanged: number;
  webUrl: string;
}

/** A Kubernetes ConfigMap or Secret change. */
export interface ConfigChange {
  resource: "ConfigMap" | "Secret";
  name: string;
  /** ISO 8601 timestamp. */
  changedAt: string;
  changedFields?: string[];
}

export interface ChangesSection {
  deployments: Deployment[];
  mergeRequests: MergeRequest[];
  configChanges: ConfigChange[];
}

// ── Infrastructure section ────────────────────────────────────────────────────

/** Resource usage and restart info for a single container in a pod. */
export interface ContainerStatus {
  name: string;
  cpuUsage: string;
  cpuLimit: string;
  memUsage: string;
  memLimit: string;
  restarts: number;
  lastRestartReason?: string;
}

/** A Kubernetes event associated with the service's workload. */
export interface K8sEvent {
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  /** ISO 8601 timestamp. */
  firstSeen: string;
  /** ISO 8601 timestamp. */
  lastSeen: string;
  count: number;
}

export interface InfrastructureSection {
  workloadType: string;
  replicas: { desired: number; ready: number; available: number };
  containers: ContainerStatus[];
  recentEvents: K8sEvent[];
}

// ── Dependency graph source ───────────────────────────────────────────────────

export type DependencyGraphSource = "prometheus" | "kubernetes" | "inferred";

// ── Section freshness ─────────────────────────────────────────────────────────

/**
 * Per-section fetch metadata so the UI can show staleness indicators and
 * gracefully degrade when a data source is unconfigured or errored.
 */
export interface SectionStatus {
  /**
   * Unix epoch milliseconds of the last successful fetch.
   * Absent for "unconfigured" and "error" states where no fetch occurred.
   */
  fetchedAt?: number;
  status: "ok" | "error" | "unconfigured" | "stale";
  error?: string;
}

// ── AI Summary ────────────────────────────────────────────────────────────────

/** AI-generated narrative summary for a service. */
export interface AISummary {
  text: string;
  /** Model confidence score 0–1, if available. */
  confidence?: number;
  /** References to evidence items that informed this summary. */
  evidenceRefs?: string[];
}

// ── Main response type ────────────────────────────────────────────────────────

/**
 * Full response payload for GET /api/services/:name/brief.
 *
 * Every data section is nullable so the server can return partial results
 * when individual data sources are unavailable. The `sections` map always
 * reflects the fetch status for each section regardless of whether data is
 * present.
 */
export interface ServiceBrief {
  /** AI-generated narrative. null when the LLM call has not yet been made. */
  summary: AISummary | null;

  /** Recent deployments, merge requests, and config changes. */
  changes: ChangesSection | null;

  /** Kubernetes workload status: replicas, containers, recent events. */
  infrastructure: InfrastructureSection | null;

  /** Service dependency graph. */
  dependencies: {
    nodes: BriefDependencyNode[];
    edges: BriefDependencyEdge[];
    /** How the graph was derived. */
    source: DependencyGraphSource;
  } | null;

  /** Per-section fetch status for staleness / error indicators in the UI. */
  sections: {
    summary: SectionStatus;
    changes: SectionStatus;
    infrastructure: SectionStatus;
    dependencies: SectionStatus;
  };

  /** Top-level errors that prevented the brief from being assembled. */
  errors: string[];
}

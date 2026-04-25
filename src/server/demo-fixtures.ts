/**
 * Demo-mode fixture builders for the service detail page.
 *
 * In live mode the brief and metrics endpoints call MCP providers (k8s,
 * GitLab, Prometheus). In demo mode there are no providers, so without
 * synthetic data the page renders empty cards and "Connect a provider..."
 * placeholders. These builders fill those panels with believable mock data
 * keyed off the service name + tier + health status, so visitors can see
 * what the live UI looks like end-to-end.
 *
 * All values are deterministic per-service: random-looking but stable across
 * page reloads (no randomness — seeded by the service name's char codes so
 * sparkline shapes don't reshuffle every fetch).
 */

import type { ServiceBrief, InfrastructureSection, ChangesSection, BriefDependencyNode, BriefDependencyEdge } from "../types/service-brief.js";
import type { MetricSeries } from "./prometheus-query.js";

// ── Tier inference ──────────────────────────────────────────────────────────

export type ServiceTier = "web" | "worker" | "datastore" | "infra";
export type ServiceHealth = "healthy" | "degraded" | "down" | "unknown";

interface DemoServiceMeta {
  tier: ServiceTier;
  health: ServiceHealth;
  namespace: string;
}

const SERVICE_META: Record<string, DemoServiceMeta> = {
  "api-gateway":         { tier: "web",       health: "healthy",  namespace: "edge" },
  "checkout-api":        { tier: "web",       health: "degraded", namespace: "commerce" },
  "auth-api":            { tier: "web",       health: "degraded", namespace: "platform" },
  "search-api":          { tier: "web",       health: "healthy",  namespace: "search" },
  "payments-worker":     { tier: "worker",    health: "down",     namespace: "commerce" },
  "inventory-worker":    { tier: "worker",    health: "down",     namespace: "commerce" },
  "notification-worker": { tier: "worker",    health: "unknown",  namespace: "platform" },
  "email-worker":        { tier: "worker",    health: "healthy",  namespace: "platform" },
  "analytics-worker":    { tier: "worker",    health: "healthy",  namespace: "analytics" },
  "postgres-primary":    { tier: "datastore", health: "healthy",  namespace: "data" },
  "postgres-replica":    { tier: "datastore", health: "healthy",  namespace: "data" },
  "redis-cache":         { tier: "datastore", health: "healthy",  namespace: "data" },
  "rabbitmq":            { tier: "datastore", health: "unknown",  namespace: "data" },
  "prometheus":          { tier: "infra",     health: "healthy",  namespace: "observability" },
  "ingress-nginx":       { tier: "infra",     health: "healthy",  namespace: "ingress-nginx" },
};

function metaFor(name: string): DemoServiceMeta {
  return SERVICE_META[name] ?? { tier: "web", health: "unknown", namespace: "default" };
}

// ── Deterministic pseudo-random (string-seeded) ─────────────────────────────

/** Mulberry32 PRNG seeded from a string. Returns a function: () => [0,1). */
function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  }
  return () => {
    h |= 0; h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── AI Summary text ─────────────────────────────────────────────────────────

const SUMMARY_TEMPLATES: Record<string, (name: string) => string> = {
  "payments-worker": () =>
    "**payments-worker** is currently **DOWN** — pod restart loop driven by connection-pool exhaustion during a recent traffic spike. " +
    "Synchronous payment authorization for `checkout-api`. The pool config didn't track the last HPA scale-out (3→8 pods), so aggregate capacity stayed at 160 connections " +
    "while concurrent demand crossed that. Active investigation in progress; downstream impact on checkout-api is the symptom most users see.",
  "inventory-worker": () =>
    "**inventory-worker** is **DOWN** — repeated OOMKills processing the latest supplier-feed batch. The stock-reconciler accumulates SKU data in a per-iteration in-memory cache " +
    "without eviction; the new batch is 3.4× normal size and crosses the 512Mi container limit. Restart re-runs the same batch and OOMs again.",
  "checkout-api": () =>
    "**checkout-api** is **DEGRADED** — p95 latency at 1.8s vs 180ms baseline. The elevation is downstream-driven from `payments-worker` pool saturation; " +
    "checkout-api's own internal metrics (auth check, cart read) remain normal. Once payments-worker recovers, checkout will follow within ~90s.",
  "auth-api": () =>
    "**auth-api** is **DEGRADED** — p95 latency at 3.2s vs 180ms baseline. Suspected cause is the JWT refresh path hitting Redis under high churn from the campaign traffic. " +
    "Investigation queued. No 5xx errors yet; clients are timing out at the upstream rather than seeing failures.",
  "notification-worker": () =>
    "**notification-worker** has `replicas=0` — scaled down for a maintenance window per CHANGELOG 0.2.1.0. The poller correctly classifies this as DOWN " +
    "(intended) rather than UNKNOWN. Re-scale to 2 replicas to resume.",
  "api-gateway": () =>
    "**api-gateway** is healthy. Edge proxy for all inbound traffic — currently routing ~340 rps with p99 at 28ms. " +
    "No anomalies in the last 24h. 3 replicas, all ready, evenly distributed across availability zones.",
  "search-api": () =>
    "**search-api** is healthy. Query rate steady at ~120 qps, p95 latency 45ms. Index freshness within 30s of postgres replica. No incidents in the last 14 days.",
  "email-worker": () =>
    "**email-worker** is healthy. Processing the SMTP send queue at ~12 messages/sec. Bounce rate <0.5%. Connection pool to upstream provider holding steady.",
  "analytics-worker": () =>
    "**analytics-worker** is healthy. Ingesting events at ~840/sec. Lag on the Kafka consumer group <5s. Rolling 7d throughput +12% week-over-week.",
  "postgres-primary": () =>
    "**postgres-primary** is healthy. 8 active connections (of 500 max), txn rate ~340/s. Replication lag to `postgres-replica` <50ms. " +
    "Last vacuum 4h ago, last analyze 12h ago. WAL retention within target.",
  "postgres-replica": () =>
    "**postgres-replica** is healthy. Streaming replication current; lag <50ms. Read traffic ~200 qps. No long-running queries.",
  "redis-cache": () =>
    "**redis-cache** is healthy. Memory at 38% saturation (1.9Gi of 5Gi). Hit rate 94.2% across all keyspaces. AOF rewrite within target. No evictions in the last 24h.",
  "rabbitmq": () =>
    "**rabbitmq** status is **UNKNOWN** — the management API is unreachable from the prober. Queues are draining based on consumer-side lag metrics, " +
    "but server-side stats can't be confirmed. Likely a temporary network issue; no operator action needed yet.",
  "prometheus": () =>
    "**prometheus** is healthy. ~2.4M active series across 24 scrape targets. WAL replay <30s. Disk usage at 41% of allocation. No dropped samples in the last 6h.",
  "ingress-nginx": () =>
    "**ingress-nginx** is healthy. Inbound rate ~412 rps across all ingress rules. Upstream connection reuse 87%. No 5xx upstream errors in the last hour.",
};

function buildDemoSummary(name: string): { text: string; confidence: number } {
  const template = SUMMARY_TEMPLATES[name];
  return {
    text: template ? template(name) : `**${name}** — no recent investigations or anomalies. Service is operating within expected ranges.`,
    confidence: 0.86,
  };
}

// ── Infrastructure section (k8s workload state) ─────────────────────────────

interface InfraSpec {
  workloadType: string;
  replicas: { desired: number; ready: number; available: number };
  cpuPct: number;
  memPct: number;
  restarts: number;
  restartReason?: string;
  events: Array<{ type: "Normal" | "Warning"; reason: string; message: string; hoursAgo: number; count: number }>;
}

function infraSpecFor(name: string, meta: DemoServiceMeta): InfraSpec {
  // Datastore tier uses StatefulSets, the rest use Deployments
  const workloadType = meta.tier === "datastore" ? "StatefulSet" : "Deployment";

  // Service-specific overrides for the dramatic ones
  if (name === "payments-worker") return {
    workloadType, replicas: { desired: 8, ready: 0, available: 0 }, cpuPct: 12, memPct: 34, restarts: 12,
    restartReason: "Error",
    events: [
      { type: "Warning", reason: "PoolAcquireTimeout", message: "DB pool acquire timed out after 5000ms (pod payments-worker-6)", hoursAgo: 2.7, count: 47 },
      { type: "Warning", reason: "BackOff", message: "Back-off restarting failed container payments (5m23s)", hoursAgo: 2.5, count: 8 },
      { type: "Warning", reason: "Unhealthy", message: "Liveness probe failed: HTTP 503 on /healthz", hoursAgo: 2.6, count: 14 },
      { type: "Normal",  reason: "Pulled",      message: "Successfully pulled image payments-worker:v3.8.1", hoursAgo: 11, count: 8 },
    ],
  };
  if (name === "inventory-worker") return {
    workloadType, replicas: { desired: 3, ready: 0, available: 0 }, cpuPct: 8, memPct: 98, restarts: 11,
    restartReason: "OOMKilled",
    events: [
      { type: "Warning", reason: "OOMKilled",    message: "Container inventory exceeded memory limit (512Mi); killed by kernel", hoursAgo: 5.5, count: 11 },
      { type: "Warning", reason: "BackOff",      message: "Back-off restarting failed container inventory (10m17s)", hoursAgo: 5.3, count: 6 },
      { type: "Normal",  reason: "Killing",      message: "Stopping container inventory", hoursAgo: 5.4, count: 11 },
      { type: "Normal",  reason: "Pulled",       message: "Successfully pulled image inventory-worker:v1.22.0", hoursAgo: 18, count: 3 },
    ],
  };
  if (name === "checkout-api") return {
    workloadType, replicas: { desired: 6, ready: 6, available: 6 }, cpuPct: 64, memPct: 71, restarts: 0,
    events: [
      { type: "Warning", reason: "Unhealthy",    message: "Readiness probe took 4.8s (target 1s) — upstream payments-worker timeout", hoursAgo: 2.4, count: 23 },
      { type: "Normal",  reason: "Scheduled",    message: "Successfully assigned commerce/checkout-api-6f9b...", hoursAgo: 4, count: 6 },
      { type: "Normal",  reason: "Pulled",       message: "Successfully pulled image checkout-api:v2.14.3", hoursAgo: 4, count: 6 },
    ],
  };
  if (name === "auth-api") return {
    workloadType, replicas: { desired: 4, ready: 4, available: 4 }, cpuPct: 38, memPct: 52, restarts: 0,
    events: [
      { type: "Warning", reason: "Unhealthy",    message: "Readiness probe latency p95 = 3.1s (target 500ms)", hoursAgo: 1.2, count: 18 },
      { type: "Normal",  reason: "Pulled",       message: "Successfully pulled image auth-api:v4.2.0", hoursAgo: 36, count: 4 },
    ],
  };
  if (name === "notification-worker") return {
    workloadType, replicas: { desired: 0, ready: 0, available: 0 }, cpuPct: 0, memPct: 0, restarts: 0,
    events: [
      { type: "Normal",  reason: "ScalingReplicaSet", message: "Scaled deployment notification-worker to 0 replicas (operator: alice@example.com)", hoursAgo: 20.3, count: 1 },
    ],
  };
  if (name === "rabbitmq") return {
    workloadType, replicas: { desired: 1, ready: 1, available: 1 }, cpuPct: 22, memPct: 41, restarts: 0,
    events: [
      { type: "Warning", reason: "ProbeError", message: "Management API probe failed (TCP connection refused on :15672) — 4 consecutive ticks", hoursAgo: 0.8, count: 4 },
    ],
  };

  // Default healthy-service template, sized by tier
  const replicaCount = meta.tier === "web" ? 3 : meta.tier === "worker" ? 2 : 1;
  return {
    workloadType,
    replicas: { desired: replicaCount, ready: replicaCount, available: replicaCount },
    cpuPct: 22 + Math.floor(seededRng(name)() * 30),
    memPct: 30 + Math.floor(seededRng(name + "m")() * 35),
    restarts: 0,
    events: [
      { type: "Normal", reason: "Pulled",    message: `Successfully pulled image ${name}:latest`, hoursAgo: 36 + Math.floor(seededRng(name + "p")() * 60), count: replicaCount },
      { type: "Normal", reason: "Scheduled", message: `Successfully assigned ${meta.namespace}/${name}-...`, hoursAgo: 36 + Math.floor(seededRng(name + "s")() * 60), count: replicaCount },
    ],
  };
}

function buildDemoInfrastructure(name: string): InfrastructureSection {
  const meta = metaFor(name);
  const spec = infraSpecFor(name, meta);
  const now = Date.now();
  const iso = (h: number) => new Date(now - h * 3_600_000).toISOString();

  // CPU/mem display strings — pick reasonable limits per tier
  const cpuLimit = meta.tier === "datastore" ? "2000m" : "1000m";
  const memLimit = meta.tier === "datastore" ? "4Gi"   : meta.tier === "worker" ? "1Gi" : "512Mi";
  const cpuLimitMillis = meta.tier === "datastore" ? 2000 : 1000;
  const memLimitMi     = meta.tier === "datastore" ? 4096 : meta.tier === "worker" ? 1024 : 512;
  const cpuUsage = `${Math.round((spec.cpuPct / 100) * cpuLimitMillis)}m`;
  const memUsage = memLimitMi >= 1024
    ? `${(((spec.memPct / 100) * memLimitMi) / 1024).toFixed(1)}Gi`
    : `${Math.round((spec.memPct / 100) * memLimitMi)}Mi`;

  return {
    workloadType: spec.workloadType,
    replicas: spec.replicas,
    containers: [
      {
        name,
        cpuUsage,
        cpuLimit,
        memUsage,
        memLimit,
        restarts: spec.restarts,
        ...(spec.restartReason ? { lastRestartReason: spec.restartReason } : {}),
      },
    ],
    recentEvents: spec.events.map((e) => ({
      type: e.type,
      reason: e.reason,
      message: e.message,
      firstSeen: iso(e.hoursAgo + 0.1),
      lastSeen: iso(e.hoursAgo),
      count: e.count,
    })),
  };
}

// ── Changes section (deployments + MRs + config) ────────────────────────────

interface DeploySpec { ref: string; pipelineStatus: string; environment: string; deployedBy: string; hoursAgo: number }
interface MrSpec     { iid: number; title: string; mergedBy: string; filesChanged: number; hoursAgo: number }

function changesFor(name: string): { deploys: DeploySpec[]; mrs: MrSpec[] } {
  if (name === "payments-worker") return {
    deploys: [
      { ref: "v3.8.1", pipelineStatus: "success", environment: "production", deployedBy: "bob",   hoursAgo: 11 },
      { ref: "v3.8.0", pipelineStatus: "success", environment: "production", deployedBy: "bob",   hoursAgo: 96 },
    ],
    mrs: [
      { iid: 4218, title: "Bump HPA max_replicas from 5 to 8 for Black Friday", mergedBy: "bob",   filesChanged: 1, hoursAgo: 11 },
      { iid: 4201, title: "Add structured logging to payments processor",       mergedBy: "alice", filesChanged: 7, hoursAgo: 96 },
    ],
  };
  if (name === "inventory-worker") return {
    deploys: [
      { ref: "v1.22.0", pipelineStatus: "success", environment: "production", deployedBy: "carol", hoursAgo: 18 },
    ],
    mrs: [
      { iid: 4225, title: "Add /batch ingestion endpoint for supplier feed",    mergedBy: "carol", filesChanged: 12, hoursAgo: 18 },
    ],
  };
  if (name === "checkout-api") return {
    deploys: [
      { ref: "v2.14.3", pipelineStatus: "success", environment: "production", deployedBy: "alice", hoursAgo: 4 },
      { ref: "v2.14.2", pipelineStatus: "success", environment: "production", deployedBy: "alice", hoursAgo: 72 },
    ],
    mrs: [
      { iid: 4231, title: "Lower upstream payments retry timeout from 30s to 10s", mergedBy: "alice", filesChanged: 2, hoursAgo: 4 },
    ],
  };
  if (name === "api-gateway") return {
    deploys: [
      { ref: "v5.1.0", pipelineStatus: "success", environment: "production", deployedBy: "dave", hoursAgo: 168 },
    ],
    mrs: [],
  };
  // Default: no recent activity
  return { deploys: [], mrs: [] };
}

function buildDemoChanges(name: string): ChangesSection {
  const { deploys, mrs } = changesFor(name);
  const now = Date.now();
  const iso = (h: number) => new Date(now - h * 3_600_000).toISOString();
  let pipelineId = 91000 + Math.floor(seededRng(name)() * 9000);
  return {
    deployments: deploys.map((d) => ({
      ref: d.ref,
      pipelineId: pipelineId++,
      pipelineStatus: d.pipelineStatus,
      environment: d.environment,
      deployedAt: iso(d.hoursAgo),
      deployedBy: d.deployedBy,
    })),
    mergeRequests: mrs.map((m) => ({
      iid: m.iid,
      title: m.title,
      mergedAt: iso(m.hoursAgo),
      mergedBy: m.mergedBy,
      filesChanged: m.filesChanged,
      webUrl: `https://gitlab.example.com/dops/${name}/-/merge_requests/${m.iid}`,
    })),
    configChanges: [],
  };
}

// ── Top-level brief ─────────────────────────────────────────────────────────

const okStatus = (fetchedAt: number) => ({ status: "ok" as const, fetchedAt });

export function buildDemoBrief(name: string): ServiceBrief {
  const now = Date.now();
  return {
    summary: buildDemoSummary(name),
    changes: buildDemoChanges(name),
    infrastructure: buildDemoInfrastructure(name),
    dependencies: buildDemoDependencyGraph(name),
    sections: {
      summary:        okStatus(now),
      changes:        okStatus(now),
      infrastructure: okStatus(now),
      dependencies:   okStatus(now),
    },
    errors: [],
  };
}

// ── Metrics (Prometheus-shaped time series) ─────────────────────────────────

/** Generate a believable random-walk time series for a metric query. */
function buildSeries(seed: string, points: number, baseline: number, volatility: number, trend = 0): [string, number][] {
  const rng = seededRng(seed);
  const stepSec = 60;
  const start = Math.floor(Date.now() / 1000) - points * stepSec;
  const out: [string, number][] = [];
  let v = baseline;
  for (let i = 0; i < points; i++) {
    const ts = String(start + i * stepSec);
    v = Math.max(0, v + (rng() - 0.5) * volatility + trend);
    out.push([ts, +v.toFixed(3)]);
  }
  return out;
}

interface MetricSpec {
  name: string;
  query: string;
  unit: string;
  baseline: number;
  volatility: number;
  trend?: number;
}

const METRICS_PER_SERVICE: Record<string, MetricSpec[]> = {
  "payments-worker": [
    { name: "5xx error rate (rps)", query: `rate(http_requests_total{service="payments-worker",status=~"5.."}[5m])`, unit: "rps",   baseline: 0.2, volatility: 4, trend: 0.05 },
    { name: "DB pool saturation",   query: `pool_active / pool_max`,                                               unit: "ratio", baseline: 0.95, volatility: 0.05 },
    { name: "p99 latency",          query: `histogram_quantile(0.99, rate(payments_duration_seconds_bucket[5m]))`, unit: "s",     baseline: 4.8, volatility: 0.6 },
    { name: "Pod restarts (cum.)",  query: `kube_pod_container_status_restarts_total{pod=~"payments-worker-.*"}`,  unit: "count", baseline: 8,   volatility: 0.2, trend: 0.04 },
  ],
  "inventory-worker": [
    { name: "Memory usage",         query: `container_memory_working_set_bytes{pod=~"inventory-worker-.*"}`,       unit: "Mi",    baseline: 480, volatility: 30, trend: 0.5 },
    { name: "Restart count",        query: `kube_pod_container_status_restarts_total{pod=~"inventory-worker-.*"}`, unit: "count", baseline: 7,   volatility: 0.3, trend: 0.05 },
  ],
  "checkout-api": [
    { name: "Request rate",         query: `rate(http_requests_total{service="checkout-api"}[5m])`,                 unit: "rps", baseline: 240, volatility: 18 },
    { name: "5xx error rate",       query: `rate(http_requests_total{service="checkout-api",status=~"5.."}[5m])`,   unit: "rps", baseline: 5.4, volatility: 1.6 },
    { name: "p95 latency",          query: `histogram_quantile(0.95, rate(http_duration_seconds_bucket[5m]))`,      unit: "s",   baseline: 1.6, volatility: 0.4 },
  ],
  "api-gateway": [
    { name: "Request rate",         query: `rate(http_requests_total{service="api-gateway"}[5m])`,                  unit: "rps", baseline: 340, volatility: 22 },
    { name: "p99 latency",          query: `histogram_quantile(0.99, rate(http_duration_seconds_bucket[5m]))`,      unit: "s",   baseline: 0.028, volatility: 0.005 },
  ],
};

const RANGE_POINTS: Record<string, number> = { "1h": 60, "6h": 90, "24h": 120, "7d": 168 };

export function buildDemoMetrics(name: string, range: string): MetricSeries[] {
  const meta = metaFor(name);
  const specs = METRICS_PER_SERVICE[name] ?? defaultMetricsForTier(meta.tier, name);
  const points = RANGE_POINTS[range] ?? 120;
  const fetchedAt = Date.now();

  return specs.map((spec) => {
    const values = buildSeries(`${name}:${spec.query}:${range}`, points, spec.baseline, spec.volatility, spec.trend ?? 0);
    const nums = values.map((v) => v[1]);
    return {
      name: spec.name,
      query: spec.query,
      unit: spec.unit,
      current: nums[nums.length - 1] ?? spec.baseline,
      values,
      min: Math.min(...nums),
      max: Math.max(...nums),
      avg: nums.reduce((a, b) => a + b, 0) / nums.length,
      fetchedAt,
    };
  });
}

// ── Dependency graph (curated topology) ─────────────────────────────────────

/**
 * Hand-authored microservices topology. The ServiceConfig metric/log labels
 * don't cross-reference each other (intentional — that would muddy the
 * discovery + probe paths), so the inferDependencyGraph() heuristic returns
 * an empty edge set and the service detail view shows just the center node.
 *
 * In demo mode we serve this curated graph instead, so visitors see a
 * realistic call topology when they click into any service.
 *
 * Edge convention: source → target means "source depends on target"
 * (i.e. source calls target, or source reads from target).
 */
const DEMO_EDGES: ReadonlyArray<{ source: string; target: string; label?: string }> = [
  // Edge ingress
  { source: "ingress-nginx",       target: "api-gateway",      label: "http" },

  // API gateway routing
  { source: "api-gateway",         target: "checkout-api",     label: "/checkout/*" },
  { source: "api-gateway",         target: "auth-api",         label: "/auth/*" },
  { source: "api-gateway",         target: "search-api",       label: "/search/*" },

  // Checkout fan-out (the busy path)
  { source: "checkout-api",        target: "payments-worker",  label: "rpc" },
  { source: "checkout-api",        target: "inventory-worker", label: "rpc" },
  { source: "checkout-api",        target: "auth-api",         label: "verify" },
  { source: "checkout-api",        target: "postgres-primary", label: "writes" },
  { source: "checkout-api",        target: "redis-cache",      label: "session" },

  // Workers
  { source: "payments-worker",     target: "postgres-primary", label: "writes" },
  { source: "payments-worker",     target: "rabbitmq",         label: "publish" },
  { source: "inventory-worker",    target: "postgres-primary", label: "writes" },
  { source: "inventory-worker",    target: "rabbitmq",         label: "publish" },
  { source: "notification-worker", target: "rabbitmq",         label: "consume" },
  { source: "notification-worker", target: "email-worker",     label: "rpc" },
  { source: "email-worker",        target: "rabbitmq",         label: "consume" },

  // Read-side services
  { source: "auth-api",            target: "postgres-primary", label: "users" },
  { source: "auth-api",            target: "redis-cache",      label: "sessions" },
  { source: "search-api",          target: "postgres-replica", label: "reads" },
  { source: "analytics-worker",    target: "postgres-replica", label: "reads" },
  { source: "analytics-worker",    target: "rabbitmq",         label: "consume" },

  // Replication
  { source: "postgres-primary",    target: "postgres-replica", label: "replication" },
];

const NODE_TYPE: Record<string, BriefDependencyNode["type"]> = {
  "postgres-primary": "database",
  "postgres-replica": "database",
  "redis-cache":      "cache",
  "rabbitmq":         "queue",
  "ingress-nginx":    "external",
};

const HEALTH_TO_NODE: Record<ServiceHealth, BriefDependencyNode["status"]> = {
  healthy:  "healthy",
  degraded: "degraded",
  down:     "unhealthy",
  unknown:  "unknown",
};

/**
 * Build a subgraph centered on `service`: include the service itself plus
 * everything one hop away (upstream callers + downstream dependencies).
 */
export function buildDemoDependencyGraph(service: string): {
  nodes: BriefDependencyNode[];
  edges: BriefDependencyEdge[];
  source: "inferred";
} {
  const related = new Set<string>([service]);
  for (const e of DEMO_EDGES) {
    if (e.source === service) related.add(e.target);
    if (e.target === service) related.add(e.source);
  }

  const nodes: BriefDependencyNode[] = [...related].map((name) => {
    const meta = metaFor(name);
    return {
      id: name,
      name,
      type: NODE_TYPE[name] ?? "service",
      status: HEALTH_TO_NODE[meta.health],
    };
  });

  const edges: BriefDependencyEdge[] = DEMO_EDGES
    .filter((e) => related.has(e.source) && related.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, ...(e.label ? { label: e.label } : {}) }));

  return { nodes, edges, source: "inferred" };
}

function defaultMetricsForTier(tier: ServiceTier, name: string): MetricSpec[] {
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (tier === "datastore") return [
    { name: "Active connections", query: `${safe}_active_connections`, unit: "count", baseline: 12, volatility: 3 },
    { name: "Operations / sec",   query: `rate(${safe}_ops_total[5m])`, unit: "ops",  baseline: 240, volatility: 28 },
  ];
  if (tier === "worker") return [
    { name: "Throughput",       query: `rate(${safe}_processed_total[5m])`, unit: "ops/s", baseline: 18, volatility: 4 },
    { name: "Queue depth",      query: `${safe}_queue_depth`,                unit: "count", baseline: 4,  volatility: 2 },
  ];
  return [
    { name: "Request rate",     query: `rate(http_requests_total{service="${safe}"}[5m])`, unit: "rps", baseline: 90, volatility: 12 },
    { name: "p95 latency",      query: `histogram_quantile(0.95, rate(http_duration_seconds_bucket{service="${safe}"}[5m]))`, unit: "s", baseline: 0.18, volatility: 0.04 },
  ];
}

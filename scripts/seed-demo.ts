/**
 * Seed the demo site's database with fixture data.
 *
 * Produces a deterministic, re-runnable dataset that makes the UI look real
 * without connecting to any actual monitoring backend. Run this before
 * starting the server with `DEMO_MODE=true`.
 *
 * Environment variables:
 *   DB_PATH    path to the SQLite database file (default: ./dops.sqlite)
 *   DATA_DIR   root directory for per-stack data (default: ./data)
 *              The seed writes DATA_DIR/default/{services,providers}.yaml
 *
 * What's seeded:
 *   - 1 default stack
 *   - 15 services across web / worker / datastore / infra tiers
 *   - 3 stub MCP providers (grafana, kubernetes, gitlab)
 *   - 5 completed investigations covering all four trigger sources
 *     (webhook / scan / operator / poller) + 1 "running" investigation
 *     frozen at phase 4 of 6 so the streaming UI shows motion
 *   - 2 scan runs (one clean, one with 2 dispatched hits)
 *   - A handful of chat messages + 2 learned incident patterns
 *
 * Relative timestamps (e.g. "most recent = 2h ago") are computed against
 * the current clock at seed time, so freshness looks right on the day the
 * seed runs. Re-run quarterly to keep the demo feeling alive.
 */

import BetterSqlite3 from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "../src/server/db.js";
import { ulid } from "ulid";
import type { RcaReport } from "../src/types/rca-types.js";

// ── Configuration ────────────────────────────────────────────────────────────

const DB_PATH = process.env["DB_PATH"] ?? "dops.sqlite";
const DATA_DIR = process.env["DATA_DIR"] ?? "data";
const NOW = Date.now();

// ── Relative time helpers ────────────────────────────────────────────────────

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function agoIso(ms: number): string {
  return new Date(NOW - ms).toISOString();
}
function agoSqlite(ms: number): string {
  // SQLite datetime('now') format: YYYY-MM-DD HH:MM:SS (UTC, no T, no Z)
  return new Date(NOW - ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}
function agoEpoch(ms: number): number {
  return NOW - ms;
}

// ── Service fixtures ─────────────────────────────────────────────────────────

interface SeedService {
  name: string;
  tier: "web" | "worker" | "datastore" | "infra";
  healthAt: "healthy" | "down" | "degraded" | "unknown";
  metrics: Array<{ query: string; description: string }>;
  logLabels: Record<string, string>;
}

const SERVICES: SeedService[] = [
  // Web / request-path
  { name: "api-gateway", tier: "web", healthAt: "healthy",
    metrics: [
      { query: `rate(http_requests_total{service="api-gateway"}[5m])`, description: "Request rate" },
      { query: `histogram_quantile(0.99, rate(http_duration_seconds_bucket{service="api-gateway"}[5m]))`, description: "P99 latency" },
    ],
    logLabels: { app: "api-gateway", namespace: "edge" } },
  { name: "checkout-api", tier: "web", healthAt: "degraded",
    metrics: [
      { query: `rate(http_requests_total{service="checkout-api",status=~"5.."}[5m])`, description: "5xx error rate" },
      { query: `rate(http_requests_total{service="checkout-api"}[5m])`, description: "Request rate" },
    ],
    logLabels: { app: "checkout-api", namespace: "commerce" } },
  { name: "auth-api", tier: "web", healthAt: "degraded",
    metrics: [
      { query: `histogram_quantile(0.95, rate(auth_latency_seconds_bucket{service="auth-api"}[5m]))`, description: "P95 auth latency" },
    ],
    logLabels: { app: "auth-api", namespace: "platform" } },
  { name: "search-api", tier: "web", healthAt: "healthy",
    metrics: [
      { query: `rate(search_queries_total[5m])`, description: "Query rate" },
    ],
    logLabels: { app: "search-api", namespace: "search" } },

  // Workers / async
  { name: "payments-worker", tier: "worker", healthAt: "down",
    metrics: [
      { query: `sum(rate(payments_processed_total[5m]))`, description: "Payments processed / sec" },
      { query: `sum(db_connections_active{service="payments-worker"}) / sum(db_connections_max{service="payments-worker"})`, description: "DB connection pool saturation" },
    ],
    logLabels: { app: "payments-worker", namespace: "commerce" } },
  { name: "inventory-worker", tier: "worker", healthAt: "down",
    metrics: [
      { query: `kube_pod_container_status_restarts_total{pod=~"inventory-worker-.*"}`, description: "Container restart count" },
      { query: `container_memory_working_set_bytes{pod=~"inventory-worker-.*"}`, description: "Working-set memory" },
    ],
    logLabels: { app: "inventory-worker", namespace: "commerce" } },
  { name: "notification-worker", tier: "worker", healthAt: "unknown",
    metrics: [
      { query: `kube_deployment_status_replicas{deployment="notification-worker"}`, description: "Replicas" },
    ],
    logLabels: { app: "notification-worker", namespace: "platform" } },
  { name: "email-worker", tier: "worker", healthAt: "healthy",
    metrics: [
      { query: `rate(email_sent_total[5m])`, description: "Email send rate" },
    ],
    logLabels: { app: "email-worker", namespace: "platform" } },
  { name: "analytics-worker", tier: "worker", healthAt: "healthy",
    metrics: [
      { query: `rate(analytics_events_ingested_total[5m])`, description: "Events ingested / sec" },
    ],
    logLabels: { app: "analytics-worker", namespace: "analytics" } },

  // Datastores
  { name: "postgres-primary", tier: "datastore", healthAt: "healthy",
    metrics: [
      { query: `pg_stat_database_numbackends{datname="app"}`, description: "Active connections" },
      { query: `rate(pg_stat_database_xact_commit{datname="app"}[5m])`, description: "Txn/s" },
    ],
    logLabels: { app: "postgres", role: "primary", namespace: "data" } },
  { name: "postgres-replica", tier: "datastore", healthAt: "healthy",
    metrics: [
      { query: `pg_replication_lag_seconds`, description: "Replication lag" },
    ],
    logLabels: { app: "postgres", role: "replica", namespace: "data" } },
  { name: "redis-cache", tier: "datastore", healthAt: "healthy",
    metrics: [
      { query: `redis_memory_used_bytes / redis_memory_max_bytes`, description: "Memory saturation" },
      { query: `rate(redis_commands_processed_total[5m])`, description: "Commands / sec" },
    ],
    logLabels: { app: "redis", namespace: "data" } },
  { name: "rabbitmq", tier: "datastore", healthAt: "unknown",
    metrics: [
      { query: `rabbitmq_queue_messages_ready`, description: "Messages ready" },
    ],
    logLabels: { app: "rabbitmq", namespace: "data" } },

  // Infra / platform
  { name: "prometheus", tier: "infra", healthAt: "healthy",
    metrics: [
      { query: `prometheus_tsdb_head_samples_appended_total`, description: "Samples appended" },
    ],
    logLabels: { app: "prometheus", namespace: "observability" } },
  { name: "ingress-nginx", tier: "infra", healthAt: "healthy",
    metrics: [
      { query: `rate(nginx_ingress_controller_requests[5m])`, description: "Ingress request rate" },
    ],
    logLabels: { app: "ingress-nginx", namespace: "ingress-nginx" } },
];

// ── RCA report fixtures ──────────────────────────────────────────────────────

const REPORT_PAYMENTS: RcaReport = {
  service: "payments-worker",
  severity: "critical",
  summary: "payments-worker connection pool exhausted during checkout traffic spike — 14 min of 5xx errors on checkout-api downstream.",
  impact: {
    duration: "14 min",
    description: "All checkout-api → payments-worker calls returned 502/503 between 14:21 and 14:35 UTC. Approx 2,100 customer checkouts failed; no data loss but users saw a generic error banner.",
  },
  trigger: "Alertmanager webhook: PaymentsWorkerErrorRateHigh (severity=critical)",
  rootCause: "Sustained 2.3x traffic spike (Black Friday pre-sale campaign) drove concurrent DB transactions past the per-pod connection pool size (20). The pool config wasn't updated after the last HPA scale-out bump from 3→8 pods, so aggregate pool capacity stayed at 160 connections while Postgres max_connections = 500. New checkouts queued on pool acquisition, tripped the 5s timeout in CheckoutService.processPayment, and surfaced as 502 Bad Gateway at the ingress.",
  contributingFactors: [
    "HPA max_replicas raised from 3 to 8 two weeks ago; pool_size in values.yaml not re-tuned.",
    "Campaign traffic forecast was 1.4x baseline; actual peak was 2.3x.",
    "No saturation alert on the connection pool — the existing alert only fires on Postgres-side max_connections, not per-pod pool.",
  ],
  timeline: [
    { time: agoIso(3 * HOUR + 24 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Campaign banner published; traffic begins climbing from 180 rps baseline." },
    { time: agoIso(3 * HOUR + 8 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "First pool-acquire timeout logged on payments-worker-6 (unnoticed)." },
    { time: agoIso(2 * HOUR + 53 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Traffic peaks at 418 rps; p99 payments latency crosses 5s." },
    { time: agoIso(2 * HOUR + 47 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Alertmanager fires PaymentsWorkerErrorRateHigh → webhook → dops." },
    { time: agoIso(2 * HOUR + 33 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "On-call doubled pool_size via kubectl edit; errors clear in 90s." },
  ],
  evidence: {
    metrics: [
      "`rate(http_requests_total{service=\"payments-worker\",status=~\"5..\"}[5m])` climbed from 0.0 to 18.4/s over 11 min (14:21-14:32 UTC).",
      "DB connection pool saturation reached 100% across all 8 payments-worker pods; queue depth on pool-acquire averaged 47 waiters.",
      "`histogram_quantile(0.99, rate(payments_duration_seconds_bucket[5m]))` spiked from 240ms baseline to 5.1s (at the 5s pool-acquire timeout).",
      "checkout-api 5xx rate reached 9.2/s at peak — every failure downstream of payments.",
    ],
    logs: [
      "payments-worker: 1,824 entries matching `pool-acquire timeout after 5000ms` (15m window).",
      "checkout-api: 2,106 entries matching `upstream connect error: 502 from payments-worker` (15m window).",
      "No DB-side errors in postgres-primary logs; max_connections never exceeded.",
    ],
    infra: [
      "kube_pod_container_status_restarts_total unchanged (no crashes — pods stayed up, just saturated).",
      "HPA reports desired_replicas=8, current_replicas=8 — already at max.",
      "kube_deployment_spec: pool_size=20 per pod × 8 pods = 160 total; Postgres max_connections=500.",
    ],
    changes: [
      "HPA max_replicas bumped 3→8 via MR !1847 (2 weeks ago). pool_size not touched.",
      "Campaign banner deploy at 14:19 UTC — 2 min before first pool-acquire timeout.",
    ],
  },
  dashboardLinks: [
    "https://grafana.demo.local/d/payments-slo/payments-worker-slo",
    "https://grafana.demo.local/d/pg-connections/postgres-connections",
  ],
  recommendedActions: [
    "IMMEDIATE: double pool_size from 20 to 40 across payments-worker (fixed — on-call applied during incident).",
    "SHORT-TERM: add a per-pod connection-pool saturation alert (`pool_acquire_wait_seconds_bucket` p99 > 2s for 5m). Existing alert watches Postgres max_connections, which won't trip until pool_size × replicas crosses 500.",
    "SHORT-TERM: tie pool_size to replica count in the Helm chart via a values.yaml formula. Prevents the same drift from recurring the next time HPA bounds change.",
    "LONG-TERM: move payments-worker onto PgBouncer transaction pooling. Would have absorbed this spike without config change.",
  ],
  confidence: "high",
  confidenceScore: 0.91,
  investigatedAt: agoIso(2 * HOUR + 30 * MINUTE),
  skillsUsed: ["k8s-deployment-inspection", "postgres-pool-analysis"],
  timeRange: { from: agoIso(3 * HOUR + 30 * MINUTE), to: agoIso(2 * HOUR + 30 * MINUTE) },
};

const REPORT_INVENTORY: RcaReport = {
  service: "inventory-worker",
  severity: "high",
  summary: "inventory-worker pod-restart storm (11 restarts in 15m) from memory leak in the stock-reconciler job.",
  impact: {
    duration: "23 min",
    description: "Two of four inventory-worker pods cycled continuously, dropping the in-flight stock-reconciliation queue depth from 340 to 2,100 until the healthy pods caught up.",
  },
  trigger: "Proactive scan rule: pod_restarts > 3 in 15m (consecutiveTicks=2)",
  rootCause: "The stock-reconciler job accumulates SKU data in a per-iteration in-memory cache without eviction. For the last reconcile batch (SKUs imported from the new supplier feed, 3.4x the normal batch size), cache growth crossed the 512Mi container memory limit, triggering an OOMKill. On restart the worker re-processed the same batch and OOM'd again.",
  contributingFactors: [
    "Supplier feed schema changed 3 days ago; new SKU format is 4x larger (varchar 200 → text with metadata JSON).",
    "No memory alert on inventory-worker — only CPU. The OOMKill showed up as a pod_restart storm rather than a CPU alert.",
    "The cache-eviction TODO from the original PR (#1247, 2026-02-14) was never done.",
  ],
  timeline: [
    { time: agoIso(6 * HOUR).replace("T", " ").slice(0, 19) + "Z", event: "Supplier feed cron fires, loads new 3.4x-size batch." },
    { time: agoIso(5 * HOUR + 42 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "inventory-worker-2 OOMKilled, k8s restarts it." },
    { time: agoIso(5 * HOUR + 28 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Pattern repeats across pods -0 and -3 on the same batch." },
    { time: agoIso(5 * HOUR + 23 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Scan probe trips pod_restarts rule for 2nd consecutive tick → dispatches investigation." },
  ],
  evidence: {
    metrics: [
      "`kube_pod_container_status_restarts_total{pod=~\"inventory-worker-.*\"}` went from 0 to 11 over 15 minutes.",
      "container_memory_working_set_bytes for inventory-worker-2 ramped from 210Mi to 512Mi (limit) linearly in ~8 minutes, then dropped to 0 (OOMKill), repeating.",
      "Stock-reconciliation queue depth: 340 → 2,100 (expected baseline 280-400).",
    ],
    logs: [
      "Pod events: 11 × `OOMKilled` on inventory-worker-{0,2,3} in 15 min.",
      "Application logs: last line before every OOM is `processing batch of 4,800 SKUs from supplier XYZ-2026-feed` (3.4x the normal 1,400 batch size).",
      "No error-level logs; process is killed by the kernel, not the app.",
    ],
    infra: [
      "Deployment resource requests: memory 256Mi / limit 512Mi. Unchanged in 14 weeks.",
      "HPA target CPU 70% — never tripped because OOMs terminate fast before CPU climbs.",
    ],
    changes: [
      "Supplier config updated in ConfigMap `inventory-feeds` via MR !1891 (3 days ago) — widens SKU schema.",
    ],
  },
  dashboardLinks: [
    "https://grafana.demo.local/d/inventory-worker/inventory-worker-overview",
  ],
  recommendedActions: [
    "IMMEDIATE: bump inventory-worker memory limit to 1Gi to let the batch complete; roll restart.",
    "SHORT-TERM: implement the cache eviction from TODO in reconciler.ts:147 (batch-scoped LRU, N=500).",
    "SHORT-TERM: add a memory-saturation alert at 85% of limit for all worker-tier deployments.",
    "LONG-TERM: stream the supplier feed batch instead of materializing it in memory. The current impl loads the full batch before processing; even a bigger limit just defers the problem.",
  ],
  confidence: "high",
  confidenceScore: 0.87,
  investigatedAt: agoIso(5 * HOUR + 20 * MINUTE),
  skillsUsed: ["k8s-pod-restart-analysis"],
  timeRange: { from: agoIso(6 * HOUR + 30 * MINUTE), to: agoIso(5 * HOUR + 20 * MINUTE) },
};

const REPORT_CHECKOUT: RcaReport = {
  service: "checkout-api",
  severity: "medium",
  summary: "checkout-api p95 latency elevated from 180ms to 1.4s during the payments-worker incident; clears when upstream recovers.",
  impact: {
    duration: "~14 min (concurrent with payments incident)",
    description: "Slow-checkout UX; no hard failures on this service, but users saw the checkout button spin for 1+ seconds before the 502 from payments surfaced. Strong downstream correlation.",
  },
  trigger: "Operator chat: \"checkout-api feels slow right now — can you look?\"",
  rootCause: "Latency elevation is downstream-driven: checkout-api calls payments-worker synchronously with a 5s upstream timeout. During the payments-worker pool saturation (see investigation INC-payments-2026-03-14), every checkout waited on the pool-acquire. checkout-api's own internal metrics (auth check, cart read) stayed normal.",
  contributingFactors: [
    "Payments calls are synchronous and on the request path — any payments latency hits the user directly.",
    "No circuit-breaker on the checkout → payments call; requests queued past the healthy budget.",
  ],
  timeline: [
    { time: agoIso(2 * HOUR + 47 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Operator asks about checkout-api slowness in chat." },
    { time: agoIso(2 * HOUR + 45 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "dops correlates checkout p95 to payments-worker pool saturation." },
    { time: agoIso(2 * HOUR + 33 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Payments-worker pool fixed → checkout p95 returns to 180ms." },
  ],
  evidence: {
    metrics: [
      "checkout-api p95 latency: 180ms baseline → 1.4s peak → 180ms recovery. Shape matches payments-worker p99 almost exactly.",
      "checkout-api request rate unchanged at baseline (no traffic anomaly on this service itself).",
      "Auth check latency (internal to checkout-api) stayed flat at ~12ms — rules out downstream-of-checkout as the cause.",
    ],
    logs: [
      "No error-level logs on checkout-api; only elevated warn rate on `upstream connect error`.",
    ],
    infra: [
      "Pod health nominal; no restarts, no CPU/memory pressure.",
    ],
  },
  dashboardLinks: [
    "https://grafana.demo.local/d/checkout-api/checkout-overview",
  ],
  recommendedActions: [
    "NO IMMEDIATE ACTION: latency recovered when upstream recovered. Cross-reference with the payments-worker investigation for the real fix.",
    "MEDIUM-TERM: add a circuit breaker (e.g. resilience4j) on the payments upstream call — fail fast at 500ms if payments is degraded, serve a \"try again\" to the user instead of queueing.",
    "MEDIUM-TERM: consider moving payment confirmation to an async, resumable flow so a slow payments-worker degrades UX gracefully instead of blocking the checkout button.",
  ],
  confidence: "high",
  confidenceScore: 0.82,
  investigatedAt: agoIso(2 * HOUR + 43 * MINUTE),
  timeRange: { from: agoIso(3 * HOUR), to: agoIso(2 * HOUR + 43 * MINUTE) },
};

const REPORT_NOTIFICATION: RcaReport = {
  service: "notification-worker",
  severity: "low",
  summary: "notification-worker deployment scaled to zero replicas — intentional maintenance mode, not an outage.",
  impact: {
    duration: "5 min",
    description: "No user-visible impact; downstream queues buffered messages during the window.",
  },
  trigger: "Health poller: service transitioned from healthy → down (replicas=0)",
  rootCause: "Deployment was scaled to 0 replicas as part of the scheduled maintenance window documented in CHANGELOG 0.2.1.0. The replica count drop is intended behavior — the scan-probe correctly classifies this as DOWN (not UNKNOWN), which is the desired behavior per the v0.1.3.0 fix.",
  contributingFactors: [
    "Maintenance window wasn't annotated as a silence in Alertmanager, so the poller fired an investigation.",
    "Scale-to-zero is an ambiguous signal — could be intentional (like here) or a HPA bug. The probe has no way to know without an annotation.",
  ],
  timeline: [
    { time: agoIso(20 * HOUR + 14 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Operator sets `kubectl scale deployment/notification-worker --replicas=0` for scheduled tuning." },
    { time: agoIso(20 * HOUR + 13 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Health poller detects replicas=0, classifies as DOWN, triggers quick investigation." },
    { time: agoIso(20 * HOUR + 9 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Investigation completes with `intentional` verdict." },
    { time: agoIso(20 * HOUR + 5 * MINUTE).replace("T", " ").slice(0, 19) + "Z", event: "Operator scales back to 2 replicas; service returns to healthy." },
  ],
  evidence: {
    metrics: [
      "kube_deployment_status_replicas{deployment=\"notification-worker\"} = 0 (from 2).",
      "kube_deployment_spec_replicas{deployment=\"notification-worker\"} = 0 (matches — intentional, not a crashloop).",
      "No `up` metric entries during the window (expected — no pods to scrape).",
    ],
    logs: [
      "No application logs during the window (nothing running).",
      "kube events: 2 × `Scaled deployment notification-worker to 0 replicas` from user `alice@company`.",
    ],
    infra: [
      "Deployment has no HPA attached — scale is under manual kubectl control.",
    ],
  },
  dashboardLinks: [],
  recommendedActions: [
    "ADD ANNOTATION: deployments under planned maintenance should carry an annotation like `dops.io/maintenance=true` so the probe can skip them. This would have suppressed this investigation entirely.",
    "ALTERNATIVELY: use an Alertmanager silence for the maintenance window.",
  ],
  confidence: "medium",
  confidenceScore: 0.72,
  investigatedAt: agoIso(20 * HOUR + 9 * MINUTE),
  timeRange: { from: agoIso(20 * HOUR + 20 * MINUTE), to: agoIso(20 * HOUR + 9 * MINUTE) },
};

// ── Seed runner ──────────────────────────────────────────────────────────────

interface SeedInvestigation {
  id: string;
  stackId: string;
  service: string;
  query: string;
  status: "running" | "complete" | "failed";
  report: RcaReport | null;
  createdAt: string;     // SQLite datetime
  completedAt: string | null;
  severity: string | null;
  source: "webhook" | "scan" | "manual" | "poller";
  tokens: { input: number; output: number; durationMs: number };
}

function main() {
  console.log(`[seed] DB_PATH=${DB_PATH}  DATA_DIR=${DATA_DIR}`);

  // Ensure parent dirs exist for the DB and data files
  mkdirSync(dirname(DB_PATH) || ".", { recursive: true });
  mkdirSync(join(DATA_DIR, "default"), { recursive: true });

  // Reset DB — the seed is the authoritative source of truth, not a merge target.
  rmSync(DB_PATH, { force: true });

  const db = new Database(DB_PATH);
  // Expose the raw better-sqlite3 handle for the hand-crafted SQL below
  // (the public Database class doesn't expose every shape we need — we want
  // to set investigations.created_at explicitly to a historical timestamp,
  // which createInvestigation hides behind DEFAULT datetime('now')).
  const raw = new BetterSqlite3(DB_PATH);

  // ── Stack ────────────────────────────────────────────────────────────────
  const stackId = ulid();
  db.createStack({
    id: stackId,
    name: "Demo",
    slug: "default",
    config: JSON.stringify({ providers: [] }),
  });
  console.log(`[seed] created default stack ${stackId}`);

  // ── services.yaml ───────────────────────────────────────────────────────
  const servicesYaml = [
    "# Seeded by scripts/seed-demo.ts — demo fixtures, not a real stack.",
    "services:",
    ...SERVICES.flatMap((s) => [
      `  - name: ${s.name}`,
      `    metrics:`,
      ...s.metrics.flatMap((m) => [
        `      - query: ${JSON.stringify(m.query)}`,
        `        description: ${JSON.stringify(m.description)}`,
      ]),
      `    logLabels:`,
      ...Object.entries(s.logLabels).map(([k, v]) => `      ${k}: ${v}`),
    ]),
  ].join("\n") + "\n";
  writeFileSync(join(DATA_DIR, "default", "services.yaml"), servicesYaml);

  // ── providers.yaml (stubs — HTTP URLs that don't resolve) ───────────────
  const providersYaml = [
    "# Seeded by scripts/seed-demo.ts — stub MCP providers for the demo.",
    "# These URLs don't resolve. In demo mode the server doesn't connect.",
    "- name: grafana-demo",
    "  roles: [metrics, logs, dashboards]",
    "  mcpServer:",
    "    transport: http",
    "    url: http://stub-grafana.invalid/mcp",
    "  webUrl: https://grafana.demo.local",
    "- name: kubernetes-demo",
    "  roles: [infrastructure]",
    "  mcpServer:",
    "    transport: http",
    "    url: http://stub-k8s.invalid/mcp",
    "- name: gitlab-demo",
    "  roles: [changes]",
    "  mcpServer:",
    "    transport: http",
    "    url: http://stub-gitlab.invalid/mcp",
    "  webUrl: https://gitlab.demo.local",
    "",
  ].join("\n");
  writeFileSync(join(DATA_DIR, "default", "providers.yaml"), providersYaml);

  // ── Service health history ──────────────────────────────────────────────
  for (const svc of SERVICES) {
    db.insertServiceHealthCheck(stackId, svc.name, svc.healthAt, agoIso(5 * MINUTE));
    // Seed a handful of past checks so the tiny history sparkline renders
    for (let i = 1; i <= 12; i++) {
      const ageMin = i * 15;
      // Flip one check to an off-state on the degraded ones so the sparkline shows movement
      const status = svc.healthAt === "degraded" && i === 3 ? "down"
        : svc.healthAt === "down" && i > 8 ? "healthy" // down services were healthy before
        : svc.healthAt;
      db.insertServiceHealthCheck(stackId, svc.name, status, agoIso(ageMin * MINUTE));
    }
  }

  // ── Investigations ──────────────────────────────────────────────────────
  const invs: SeedInvestigation[] = [
    {
      id: `inv_${ulid()}`,
      stackId,
      service: "payments-worker",
      query: "SCAN: payments-worker ERROR_RATE_HIGH tripped for 2 consecutive ticks.",
      status: "complete",
      report: REPORT_PAYMENTS,
      createdAt: agoSqlite(2 * HOUR + 47 * MINUTE),
      completedAt: agoSqlite(2 * HOUR + 30 * MINUTE),
      severity: "critical",
      source: "webhook",
      tokens: { input: 18_400, output: 4_200, durationMs: 94_000 },
    },
    {
      id: `inv_${ulid()}`,
      stackId,
      service: "inventory-worker",
      query: "SCAN: pod_restarts > 3 in 15m.",
      status: "complete",
      report: REPORT_INVENTORY,
      createdAt: agoSqlite(5 * HOUR + 23 * MINUTE),
      completedAt: agoSqlite(5 * HOUR + 8 * MINUTE),
      severity: "high",
      source: "scan",
      tokens: { input: 12_800, output: 3_100, durationMs: 71_000 },
    },
    {
      id: `inv_${ulid()}`,
      stackId,
      service: "checkout-api",
      query: "checkout-api feels slow right now — can you look?",
      status: "complete",
      report: REPORT_CHECKOUT,
      createdAt: agoSqlite(2 * HOUR + 47 * MINUTE),
      completedAt: agoSqlite(2 * HOUR + 43 * MINUTE),
      severity: "medium",
      source: "manual",
      tokens: { input: 7_400, output: 1_800, durationMs: 42_000 },
    },
    {
      id: `inv_${ulid()}`,
      stackId,
      service: "notification-worker",
      query: "Service health check: notification-worker transitioned from healthy to down.",
      status: "complete",
      report: REPORT_NOTIFICATION,
      createdAt: agoSqlite(20 * HOUR + 13 * MINUTE),
      completedAt: agoSqlite(20 * HOUR + 9 * MINUTE),
      severity: "low",
      source: "poller",
      tokens: { input: 4_200, output: 900, durationMs: 28_000 },
    },
    {
      id: `inv_${ulid()}`,
      stackId,
      service: "auth-api",
      query: "auth-api p95 latency climbing — can you investigate?",
      status: "running",
      report: null,
      createdAt: agoSqlite(2 * MINUTE),
      completedAt: null,
      severity: null,
      source: "manual",
      tokens: { input: 0, output: 0, durationMs: 0 },
    },
  ];

  const insertInv = raw.prepare(`
    INSERT INTO investigations
      (id, service, query, status, report, stack_id, created_at, completed_at, severity,
       total_input_tokens, total_output_tokens, total_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const inv of invs) {
    insertInv.run(
      inv.id, inv.service, inv.query, inv.status,
      inv.report ? JSON.stringify(inv.report) : null,
      inv.stackId, inv.createdAt, inv.completedAt, inv.severity,
      inv.tokens.input, inv.tokens.output, inv.tokens.durationMs,
    );
  }
  console.log(`[seed] inserted ${invs.length} investigations`);

  // ── Phases for the running investigation ────────────────────────────────
  // Shows the pipeline as: prefetch✓, anomaly✓, planning✓, metrics🏃, logs pending, ...
  const runningInv = invs.find((i) => i.status === "running")!;
  const insertPhase = raw.prepare(`
    INSERT INTO investigation_phases (id, investigation_id, phase, status, findings, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const phaseSeeds: Array<{ phase: string; status: string; startedAgoMs: number; completedAgoMs: number | null; findings: string | null }> = [
    { phase: "Detecting anomalies", status: "complete", startedAgoMs: 2 * MINUTE, completedAgoMs: 1 * MINUTE + 48_000, findings: "auth-api p95 latency 180ms → 720ms starting 14:02 UTC; p50 unchanged." },
    { phase: "Planning investigation", status: "complete", startedAgoMs: 1 * MINUTE + 48_000, completedAgoMs: 1 * MINUTE + 32_000, findings: "hypotheses: (1) token-service latency spike, (2) postgres-primary saturation, (3) recent deploy." },
    { phase: "Analyzing metrics", status: "running", startedAgoMs: 1 * MINUTE + 32_000, completedAgoMs: null, findings: null },
    { phase: "Analyzing logs", status: "pending", startedAgoMs: 0, completedAgoMs: null, findings: null },
    { phase: "Checking infrastructure", status: "pending", startedAgoMs: 0, completedAgoMs: null, findings: null },
    { phase: "Synthesizing root cause", status: "pending", startedAgoMs: 0, completedAgoMs: null, findings: null },
  ];
  for (const p of phaseSeeds) {
    const startedAt = p.startedAgoMs > 0 ? agoSqlite(p.startedAgoMs) : agoSqlite(0);
    const completedAt = p.completedAgoMs !== null ? agoSqlite(p.completedAgoMs) : null;
    insertPhase.run(`ph_${ulid()}`, runningInv.id, p.phase, p.status, p.findings, startedAt, completedAt);
  }
  console.log(`[seed] inserted ${phaseSeeds.length} phases for running investigation`);

  // Also add a couple of phases to the completed payments investigation so the
  // phase rail on that detail view shows a full 6/6 on hover.
  const paymentsInv = invs.find((i) => i.service === "payments-worker")!;
  const completedPhases = ["Detecting anomalies", "Planning investigation", "Analyzing metrics", "Analyzing logs", "Checking infrastructure", "Synthesizing root cause"];
  for (let i = 0; i < completedPhases.length; i++) {
    const startOffset = (2 * HOUR + 47 * MINUTE) - (i * 3 * MINUTE);
    const endOffset = startOffset - (2 * MINUTE + 30_000);
    insertPhase.run(
      `ph_${ulid()}`,
      paymentsInv.id,
      completedPhases[i]!,
      "complete",
      null,
      agoSqlite(startOffset),
      agoSqlite(endOffset),
    );
  }

  // ── Scan runs ───────────────────────────────────────────────────────────
  // Run 1: clean tick from ~1 hour ago. No hits.
  const cleanRunId = `sr_${ulid()}`;
  db.insertScanRun({
    id: cleanRunId,
    stackId,
    trigger: "cron",
    startedAt: agoEpoch(1 * HOUR + 5 * MINUTE),
  });
  db.updateScanRun(cleanRunId, {
    status: "complete",
    finishedAt: agoEpoch(1 * HOUR + 5 * MINUTE - 4_200),
    servicesProbed: 15,
    rulesApplied: 42,
    queriesExecuted: 42,
    probeErrors: 0,
    queriesEmpty: 3,
    probeDurationMs: 4_200,
    hitsRaw: 0,
    hitsAfterDedup: 0,
    hitsDispatched: 0,
    droppedByCap: 0,
  });

  // Run 2: hit tick that dispatched both inventory + payments investigations.
  const hitRunId = `sr_${ulid()}`;
  db.insertScanRun({
    id: hitRunId,
    stackId,
    trigger: "cron",
    startedAt: agoEpoch(5 * HOUR + 25 * MINUTE),
  });
  db.updateScanRun(hitRunId, {
    status: "complete",
    finishedAt: agoEpoch(5 * HOUR + 25 * MINUTE - 6_800),
    servicesProbed: 15,
    rulesApplied: 42,
    queriesExecuted: 42,
    probeErrors: 0,
    queriesEmpty: 2,
    probeDurationMs: 6_800,
    hitsRaw: 2,
    hitsAfterDedup: 2,
    hitsDispatched: 2,
    droppedByCap: 0,
  });
  const inventoryInv = invs.find((i) => i.service === "inventory-worker")!;
  db.linkScanRunInvestigation(hitRunId, inventoryInv.id, {
    service: "inventory-worker",
    ruleName: "pod_restarts",
    value: 11,
    severity: 3,
    dispatchedAt: agoEpoch(5 * HOUR + 23 * MINUTE),
  });
  db.linkScanRunInvestigation(hitRunId, paymentsInv.id, {
    service: "payments-worker",
    ruleName: "error_rate_high",
    value: 18.4,
    severity: 4,
    dispatchedAt: agoEpoch(5 * HOUR + 23 * MINUTE),
  });
  console.log(`[seed] inserted 2 scan runs (1 clean, 1 with 2 dispatched hits)`);

  // ── Chat messages (a short conversation around the checkout investigation) ─
  db.createMessage(stackId, {
    id: `msg_${ulid()}`,
    role: "user",
    content: "checkout-api feels slow right now — can you look?",
  });
  db.createMessage(stackId, {
    id: `msg_${ulid()}`,
    role: "assistant",
    content: "Starting investigation of **checkout-api**...",
    investigationId: invs.find((i) => i.service === "checkout-api")!.id,
  });
  db.createMessage(stackId, {
    id: `msg_${ulid()}`,
    role: "assistant",
    content: "Investigation complete. Latency on checkout-api tracked payments-worker's pool saturation almost exactly — this is a downstream effect, not a checkout-api issue. See the full RCA →",
    investigationId: invs.find((i) => i.service === "checkout-api")!.id,
  });

  // ── Learned patterns (AP10 feedback loop) ───────────────────────────────
  db.createPattern(stackId, {
    id: `pat_${ulid()}`,
    service: "payments-worker",
    symptom: "5xx spike + pool-acquire timeouts",
    rootCause: "connection pool under-sized after HPA scale-out — pool_size didn't track replica count",
    severity: "high",
    recommendedActions: "Tie pool_size to replica count in Helm values.yaml; add pool-saturation alert",
    sourceInvestigationId: paymentsInv.id,
  });
  db.createPattern(stackId, {
    id: `pat_${ulid()}`,
    service: "inventory-worker",
    symptom: "periodic OOMKill + pod restart storm",
    rootCause: "in-memory cache grows with batch size, no eviction",
    severity: "high",
    recommendedActions: "Implement batch-scoped LRU cache; stream batch instead of materializing",
    sourceInvestigationId: invs.find((i) => i.service === "inventory-worker")!.id,
  });

  // ── Thumbs-up feedback on the completed investigations ──────────────────
  for (const inv of invs.filter((i) => i.status === "complete")) {
    db.createFeedback(stackId, { id: `fb_${ulid()}`, investigationId: inv.id, rating: "useful" });
  }

  // ── Demo-mode notification settings ─────────────────────────────────────
  // Leave Slack disabled (no webhook URL). Enable email with fake recipients
  // so the Notifications tab has something to render.
  db.setSetting("notifications.slack.enabled", "false");
  db.setSetting("notifications.email.enabled", "true");

  raw.close();
  db.close();

  console.log(`[seed] done.`);
  console.log(`[seed] start the demo server:`);
  console.log(`[seed]   DEMO_MODE=true DB_PATH=${DB_PATH} DATA_DIR=${DATA_DIR} CONFIG_PATH=demo/config.yaml npm run web`);
}

main();

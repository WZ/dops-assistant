import { getToolsByRole } from "../../mcp/provider.js";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { OnToolCallEnriched, OnIteration } from "../../types/agent-interfaces.js";
import type { Tool } from "@mastra/core/tools";
import { createLogger } from "../../logger.js";
import { throwIfDiscoveryAborted } from "./discover/index.js";

const logger = createLogger("validate");

export interface ValidateStepConfig {
  providers: MastraProvider[];
  services: ServiceConfig[];
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /** Caller cancellation signal (e.g. WebSocket disconnect, supersede-on-new-discover). */
  abortSignal?: AbortSignal;
}

// Default Loki/Prometheus label keys for K8s environments, used to match
// discovered service names against Loki label values during the validate
// phase's log-label enrichment fallback.
const SERVICE_LABEL_KEYS = [
  "app",
  "container_name",
  "job",
  "component",
  "name",
  "service",
  "chart",
  "release",
];

/**
 * Unwrap an MCP tool result to its parsed JSON payload.
 * MCP results may be raw JSON, a JSON string, or wrapped in {"content": [{"text": "..."}]}.
 */
function unwrapMcpJson(result: unknown): any {
  try {
    const outer = typeof result === "string" ? JSON.parse(result) : result;
    if (outer?.content?.[0]?.text) {
      return JSON.parse(outer.content[0].text);
    }
    return outer;
  } catch {
    return result;
  }
}

/**
 * Find a tool by name suffix within a role's tool set.
 * Returns [toolName, tool] tuple or undefined if not found.
 */
function findToolBySuffix(tools: Record<string, Tool>, suffix: string): [string, Tool] | undefined {
  const entry = Object.entries(tools).find(([name]) => name.endsWith(suffix));
  return entry as [string, Tool] | undefined;
}

/**
 * Deterministic validation + log label enrichment.
 *
 * 1. Verify each service's Prometheus metric query returns data
 * 2. Enrich logLabels by fuzzy-matching service names against Loki label values
 * 3. Verify matched log labels return data
 */
export async function runValidateStep(config: ValidateStepConfig): Promise<ValidatedServiceConfig[]> {
  throwIfDiscoveryAborted(config.abortSignal);
  config.onIteration?.("validation", 0, config.services.length, "Resolving MCP tools...");

  // Resolve tools by role instead of scanning all providers
  const [metricsTools, logsTools, dashboardsTools, infraTools] = await Promise.all([
    getToolsByRole(config.providers, "metrics").catch(() => ({})),
    getToolsByRole(config.providers, "logs").catch(() => ({})),
    getToolsByRole(config.providers, "dashboards").catch(() => ({})),
    getToolsByRole(config.providers, "infrastructure").catch(() => ({})),
  ]);
  throwIfDiscoveryAborted(config.abortSignal);

  const promTool = findToolBySuffix(metricsTools, "query_prometheus");
  const lokiLabelNamesTool = findToolBySuffix(logsTools, "list_loki_label_names");
  const lokiLabelValuesTool = findToolBySuffix(logsTools, "list_loki_label_values");
  const lokiTool = findToolBySuffix(logsTools, "query_loki_logs");
  const podsListTool = findToolBySuffix(infraTools, "pods_list");

  logger.info({
    serviceCount: config.services.length,
    hasPrometheusTool: Boolean(promTool),
    hasLokiTool: Boolean(lokiTool),
    hasPodsListTool: Boolean(podsListTool),
  }, "discovery validation: start");

  logger.debug(`Starting validation of ${config.services.length} services`);
  logger.debug(`Metrics tools: ${Object.keys(metricsTools).join(", ") || "(none)"}`);
  logger.debug(`Logs tools: ${Object.keys(logsTools).join(", ") || "(none)"}`);
  logger.debug(`Dashboards tools: ${Object.keys(dashboardsTools).join(", ") || "(none)"}`);
  logger.debug(`Infra tools: ${Object.keys(infraTools).join(", ") || "(none)"}`);

  // Find datasource listing tool — try dashboards role first, fall back to metrics role
  const listDsTool = findToolBySuffix(dashboardsTools, "list_datasources")
    ?? findToolBySuffix(metricsTools, "list_datasources");
  const lokiDsUid = await findLokiDatasourceUid(listDsTool, config);

  config.onIteration?.("validation", 0, config.services.length, "Enriching log labels from K8s...");

  // Phase 0: Enrich log labels from K8s pod data (ground truth — namespace + labels)
  const k8sEnriched = await enrichFromK8s(config.services, podsListTool, config);
  throwIfDiscoveryAborted(config.abortSignal);

  // Phase 1: Enrich remaining empty logLabels by matching service names against Loki label values (fallback)
  const labelMap = await buildLabelMap(lokiLabelNamesTool, lokiLabelValuesTool, lokiDsUid, config, SERVICE_LABEL_KEYS);
  const enriched = enrichLogLabels(k8sEnriched, labelMap);
  throwIfDiscoveryAborted(config.abortSignal);

  // Phase 2: Validate metrics and logs for each service
  const results: ValidatedServiceConfig[] = [];

  for (let i = 0; i < enriched.length; i++) {
    throwIfDiscoveryAborted(config.abortSignal);
    const service = enriched[i];
    let metricsOk = false;
    let logsOk = false;
    const notes: string[] = [];

    config.onIteration?.("validation", i + 1, enriched.length, `Checking ${service.name}`);

    // Check metrics — and repair if the agent's pick returns empty.
    if (promTool && service.metrics.length > 0) {
      try {
        const query = service.metrics[0].query;
        const start = Date.now();
        const result = await promTool[1].execute!({ expr: query, queryType: "instant" }, {} as any);
        const duration = Date.now() - start;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        config.onToolCall?.(promTool[0], { expr: query }, resultStr, duration, undefined, "validation");

        metricsOk = resultStr.length > 10 && !resultStr.includes('"result":[]');
        notes.push(metricsOk ? "metrics \u2713" : "metrics \u2717 no data");
      } catch (err) {
        notes.push("metrics \u2717 query failed");
        config.onToolCall?.(promTool[0], { expr: service.metrics[0].query }, undefined, 0, String(err), "validation");
      }

      // Verify-before-keep: the agent's metric pick returned empty. This is
      // the single largest source of scan-probe blind spots observed on
      // real stacks — services where the agent speculated a query pattern
      // without confirming it resolves. Try a small list of k8s-native
      // fallbacks; keep the first one that returns data. Mutates the
      // service's metrics[0] AND the paired service_availability probe
      // rule so the probe actually uses the working query next tick.
      if (!metricsOk) {
        const replacement = await tryMetricFallback(promTool, service.name, config);
        if (replacement) {
          service.metrics[0] = { query: replacement, description: "validate-step fallback (original returned empty)" };
          syncServiceAvailabilityRule(service, replacement);
          metricsOk = true;
          notes.push(`metrics \u2713 repaired via fallback (${replacement.slice(0, 60)}${replacement.length > 60 ? "\u2026" : ""})`);
        }
      }
    } else {
      notes.push("metrics \u2717 no tool or no query");
    }

    // Check logs (only if we enriched logLabels)
    if (lokiTool && Object.keys(service.logLabels).length > 0) {
      try {
        const labels = Object.entries(service.logLabels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",");
        const query = `{${labels}}`;
        const start = Date.now();
        const result = await lokiTool[1].execute!({ query, limit: 1 }, {} as any);
        const duration = Date.now() - start;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        config.onToolCall?.(lokiTool[0], { query, limit: 1 }, resultStr, duration, undefined, "validation");

        logsOk = resultStr.length > 10 && !resultStr.includes('"result":[]');
        notes.push(logsOk ? "logs \u2713" : "logs \u2717 no data");
      } catch (err) {
        notes.push("logs \u2717 query failed");
      }
    } else {
      notes.push("logs n/a");
    }

    const hasLogLabels = Object.keys(service.logLabels).length > 0;
    let confidence: "verified" | "partial" | "unverified";
    if (metricsOk && (logsOk || !hasLogLabels)) {
      confidence = "verified";
    } else if (metricsOk || logsOk) {
      confidence = "partial";
    } else {
      confidence = "unverified";
    }

    results.push({
      ...service,
      confidence,
      validationNotes: notes.join(", "),
    });
  }

  // Phase 3 — deterministic app-metric enrichment.
  // metrics[0] is the health check (per discover prompt Layer 6.1). metrics[1..]
  // are service-specific counters / histograms / queue gauges that operators
  // look at when triaging an incident. Empirics on stack-120 showed the LLM
  // never volunteers metrics[1..] without explicit prompting, and the explicit
  // prompt (iter 1's Layer 6.5) burned iteration budget. Iter 3 moves the work
  // here: one Prometheus probe per service against `{__name__=~"<prefix>.*"}`,
  // then a quick scoring pass picks 3 informative metrics.
  if (promTool) {
    config.onIteration?.("validation", results.length, results.length, "Enriching app metrics...");
    await enrichApplicationMetrics(results, promTool, config);
  }

  const verified = results.filter((r) => r.confidence === "verified").length;
  const partial = results.filter((r) => r.confidence === "partial").length;
  const unverified = results.filter((r) => r.confidence === "unverified").length;
  logger.info({
    serviceCount: results.length,
    verified,
    partial,
    unverified,
  }, "discovery validation: complete");
  logger.debug(`Done: ${verified} verified, ${partial} partial, ${unverified} unverified`);

  return results;
}

// ── Application metric enrichment ──────────────────────────────────────────

const APP_METRIC_LIMIT_PER_SERVICE = 3;

/** Generic infra metric prefixes that should NEVER be picked as service-specific
 *  app metrics — they're stack-wide and useless on a service detail page. */
const GENERIC_METRIC_PREFIXES = [
  "kube_", "container_", "node_", "process_", "go_", "promhttp_",
  "prometheus_", "alertmanager_", "loki_", "grafana_",
];

interface AppMetricCandidate {
  name: string;
  seriesCount: number;
  rank: number; // lower = better
}

/**
 * Derive an underscore-prefix hint from a service name so the LLM-emitted
 * service name (`ingestion-server`) maps to its Prometheus metric prefix
 * (`ingestion_`). Returns the prefix WITHOUT the trailing wildcard.
 *
 * `ingestion-server` → `ingestion_server` (keep both halves; some apps emit
 *                                          `ingestion_server_*` metrics)
 * `ch-clickhouse-shard0` → `clickhouse_` (drop ch- prefix; shards share
 *                                         the same `clickhouse_*` namespace)
 * `kafka-cluster-kafka` → `kafka_`
 *
 * We try a small ladder of prefixes per service (full normalized, then each
 * dash-separated chunk) and combine results — Prometheus regex alternation
 * is cheap.
 */
function derivePrefixCandidates(serviceName: string): string[] {
  const normalized = serviceName.replace(/-/g, "_");
  const parts = serviceName.split("-").filter(Boolean);
  const out = new Set<string>([normalized]);
  for (const part of parts) {
    if (part.length >= 4) out.add(part); // skip 1-3 char fragments — too noisy
  }
  return [...out];
}

/** Wrap a counter/gauge/histogram-bucket name into a UI-friendly PromQL query. */
function formatMetricQuery(metricName: string): { query: string; description: string } {
  if (metricName.endsWith("_bucket")) {
    const root = metricName.replace(/_bucket$/, "");
    return {
      query: `histogram_quantile(0.99, sum by (le) (rate(${metricName}[5m])))`,
      description: `${root} p99`,
    };
  }
  if (metricName.endsWith("_total") || metricName.endsWith("_count")) {
    return {
      query: `sum(rate(${metricName}[5m]))`,
      description: `${metricName.replace(/_total$|_count$/, "")} rate`,
    };
  }
  return { query: metricName, description: metricName };
}

/** Score a metric name — lower = picked first. */
function rankMetric(name: string, seriesCount: number): number {
  // Penalize generic infra namespaces (we should have filtered these by
  // prefix, but a metric like `kube_pod_ingestion_health_total` could slip in
  // because of substring match in the regex). Down-rank rather than drop so
  // we still get something if the service has nothing else.
  let r = 0;
  if (GENERIC_METRIC_PREFIXES.some((p) => name.startsWith(p))) r += 100;

  // Errors/lag/queue/duration win their categories.
  if (/(_errors_total|_failed_total|_rejected_total)$/.test(name)) r += 0;
  else if (/(_duration_seconds_bucket|_latency_.*_bucket)$/.test(name)) r += 1;
  else if (/(_queue_size|_lag|_backlog|_pending)$/.test(name)) r += 2;
  else if (/(_total|_count)$/.test(name)) r += 3;
  else r += 5;

  // Tiebreak: prefer metrics that have only a moderate number of series —
  // tens of series typically means per-pod/per-topic, useful. Thousands of
  // series usually means a high-cardinality label we don't want by default.
  if (seriesCount > 200) r += 10;
  if (seriesCount > 1000) r += 50;

  return r;
}

function parseCountByName(resultText: string): Array<{ name: string; seriesCount: number }> {
  try {
    // MCP results are commonly wrapped in {"content":[{"text":"<inner JSON>"}]};
    // `unwrapMcpJson` peels both layers and returns the parsed inner object.
    const obj = unwrapMcpJson(resultText) as unknown;
    const rows: unknown[] =
      (obj as { data?: { result?: unknown[] } })?.data?.result
      ?? (obj as { result?: unknown[] })?.result
      ?? (Array.isArray((obj as { data?: unknown })?.data) ? ((obj as { data: unknown[] }).data) : [])
      ?? [];
    const out: Array<{ name: string; seriesCount: number }> = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as { metric?: Record<string, string>; value?: [number, string] };
      const name = r.metric?.["__name__"];
      const v = r.value?.[1];
      if (!name) continue;
      const count = v ? parseFloat(v) : 0;
      out.push({ name, seriesCount: Number.isFinite(count) ? count : 0 });
    }
    return out;
  } catch {
    return [];
  }
}

async function enrichApplicationMetrics(
  services: ValidatedServiceConfig[],
  promTool: [string, Tool],
  config: ValidateStepConfig,
): Promise<void> {
  let added = 0;
  for (const service of services) {
    throwIfDiscoveryAborted(config.abortSignal);

    // Skip services where the LLM already emitted multiple metrics — trust it.
    if (service.metrics.length > 1) continue;

    const prefixes = derivePrefixCandidates(service.name).map((p) => `${p}.*`);
    const regex = prefixes.join("|");
    const query = `count by (__name__) ({__name__=~"${regex}"})`;

    let resultText = "";
    try {
      const start = Date.now();
      const raw = await promTool[1].execute!({ expr: query, queryType: "instant" }, {} as any);
      const duration = Date.now() - start;
      resultText = typeof raw === "string" ? raw : JSON.stringify(raw);
      config.onToolCall?.(promTool[0], { expr: query }, resultText, duration, undefined, "validation");
    } catch (err) {
      config.onToolCall?.(promTool[0], { expr: query }, undefined, 0, String(err), "validation");
      continue;
    }

    const parsed = parseCountByName(resultText);
    if (parsed.length === 0) continue;

    // Drop generic infra metrics by prefix; rank what remains.
    const filtered = parsed.filter(
      (m) => !GENERIC_METRIC_PREFIXES.some((p) => m.name.startsWith(p)),
    );
    if (filtered.length === 0) continue;

    // Drop metrics whose name is exactly the existing metrics[0] root.
    const existingRoots = new Set(
      service.metrics.map((m) => m.query.replace(/^.*\b([a-z_][a-z_0-9]*)\b.*$/, "$1")),
    );
    const candidates: AppMetricCandidate[] = filtered
      .filter((m) => !existingRoots.has(m.name))
      .map((m) => ({ name: m.name, seriesCount: m.seriesCount, rank: rankMetric(m.name, m.seriesCount) }))
      .sort((a, b) => a.rank - b.rank || b.seriesCount - a.seriesCount || a.name.localeCompare(b.name));

    const picks = candidates.slice(0, APP_METRIC_LIMIT_PER_SERVICE);
    if (picks.length === 0) continue;

    for (const pick of picks) {
      service.metrics.push(formatMetricQuery(pick.name));
      added++;
    }
  }
  if (added > 0) {
    logger.info({ servicesEnriched: services.filter((s) => s.metrics.length > 1).length, metricsAdded: added }, "discovery validation: app metrics enriched");
  }
}

/**
 * Strip k8s Service suffixes that don't appear on the backing workload name.
 * A Service named `foo-headless` almost always fronts a workload named `foo`.
 */
function stripServiceSuffix(name: string): string {
  return name.replace(/-(headless|svc|service)$/u, "");
}

/**
 * Sanitize a service name for safe embedding in a PromQL label selector.
 * Must match the sanitizer the probe uses in anomaly-probe.ts so the repair
 * path produces the same string the probe will evaluate.
 */
function sanitizeForPromQL(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.\-]/g, "");
}

/**
 * Candidate availability queries tried in order when the agent's original
 * pick returned empty. Ordered from most likely to resolve + most specific
 * (workload-type kube-state-metrics labels) down to broad fallbacks (`up`
 * by various label keys). First match wins.
 *
 * The substitutes use the exact service name AND a suffix-stripped form
 * (`foo-headless` → `foo`) because Service-fronting-StatefulSet is the
 * single biggest blind-spot pattern we've seen on real stacks.
 */
function buildFallbackCandidates(rawServiceName: string): string[] {
  const safeOriginal = sanitizeForPromQL(rawServiceName);
  const stripped = stripServiceSuffix(safeOriginal);
  const bothNames = stripped !== safeOriginal ? [safeOriginal, stripped] : [safeOriginal];
  const candidates: string[] = [];
  for (const n of bothNames) {
    candidates.push(`kube_deployment_status_replicas_available{deployment="${n}"}`);
    candidates.push(`kube_statefulset_status_replicas_ready{statefulset="${n}"}`);
    candidates.push(`kube_daemonset_status_number_ready{daemonset="${n}"}`);
    candidates.push(`up{app="${n}"}`);
    candidates.push(`up{job="${n}"}`);
    candidates.push(`up{service="${n}"}`);
  }
  return candidates;
}

/**
 * Probe each candidate query via the metrics MCP tool; return the first one
 * that returns a non-empty result. Never throws — each attempt is isolated.
 * Caller treats `undefined` as "give up, keep the agent's original".
 */
async function tryMetricFallback(
  promTool: [string, Tool],
  serviceName: string,
  config: ValidateStepConfig,
): Promise<string | undefined> {
  for (const candidate of buildFallbackCandidates(serviceName)) {
    try {
      const start = Date.now();
      const result = await promTool[1].execute!({ expr: candidate, queryType: "instant" }, {} as any);
      const duration = Date.now() - start;
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      config.onToolCall?.(promTool[0], { expr: candidate }, resultStr, duration, undefined, "validation");
      if (resultStr.length > 10 && !resultStr.includes('"result":[]')) {
        return candidate;
      }
    } catch {
      // Candidate threw (e.g., MCP rejected the query shape) — try the next.
      continue;
    }
  }
  return undefined;
}

/**
 * Keep `service_availability` probe rule in sync with metrics[0]. The
 * service_availability rule was backfilled in validateDiscoveredServices
 * as a copy of the original metrics[0].query. If validate-step just
 * repaired metrics[0], the probe rule must update to match or the probe
 * will keep hitting the broken original.
 */
function syncServiceAvailabilityRule(service: ServiceConfig, newQuery: string): void {
  const rules = service.probeRules ?? [];
  const rule = rules.find((r) => r.name === "service_availability");
  if (rule) rule.query = newQuery;
}

/**
 * Enrich service logLabels using K8s pod data (ground truth).
 *
 * Calls pods_list once, parses the tabular output, and matches services
 * to pods by name. Extracts namespace and labels (app, component, etc.)
 * for each matched service.
 */
async function enrichFromK8s(
  services: ServiceConfig[],
  podsListTool: [string, Tool] | undefined,
  config: ValidateStepConfig,
): Promise<ServiceConfig[]> {
  if (!podsListTool) {
    logger.warn("No pods_list tool — skipping K8s enrichment");
    return services;
  }

  let podRows: Array<{ name: string; namespace: string; labels: Record<string, string> }>;
  try {
    const start = Date.now();
    const result = await podsListTool[1].execute!({}, {} as any);
    const duration = Date.now() - start;
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    config.onToolCall?.(podsListTool[0], {}, resultStr.slice(0, 2000), duration, undefined, "validation");

    podRows = parsePodsList(resultStr);
    logger.debug(`K8s pods_list: parsed ${podRows.length} pods`);
  } catch (err) {
    logger.warn(`K8s pods_list failed: ${err}`);
    return services;
  }

  if (podRows.length === 0) return services;

  let enrichedCount = 0;

  const result = services.map((service) => {
    // Skip if logLabels already has namespace (fully enriched)
    if (service.logLabels?.namespace) return service;

    const nameVariants = normalizeName(service.name);

    // Match pod by: pod name contains service name, or labels.app matches
    const matched = podRows.find((pod) => {
      const podLower = pod.name.toLowerCase();
      for (const variant of nameVariants) {
        if (podLower.startsWith(variant) || podLower.includes(variant)) return true;
      }
      const appLabel = pod.labels["app"]?.toLowerCase();
      if (appLabel) {
        for (const variant of nameVariants) {
          if (appLabel === variant || appLabel.includes(variant)) return true;
        }
      }
      return false;
    });

    if (!matched) return service;

    // Merge K8s data into existing logLabels (preserve LLM-provided labels, add namespace)
    const logLabels: Record<string, string> = { ...service.logLabels, namespace: matched.namespace };

    // Add container label if not already present
    if (!logLabels["container"] && !logLabels["app"]) {
      if (matched.labels["app"]) {
        logLabels["container"] = matched.labels["app"];
      } else {
        logLabels["container"] = service.name;
      }
    }

    enrichedCount++;
    logger.debug(`K8s match: "${service.name}" → namespace=${matched.namespace}, container=${logLabels["container"]} (pod=${matched.name})`);
    return { ...service, logLabels };
  });

  logger.debug(`K8s enrichment: ${enrichedCount}/${services.length} services matched`);
  return result;
}

/**
 * Parse the tabular output from pods_list into structured rows.
 *
 * Expected format (space-separated with LABELS as last column):
 *   NAMESPACE   APIVERSION   KIND   NAME   READY   STATUS   RESTARTS   AGE   IP   NODE   ...   LABELS
 *   admin-new   v1           Pod    admin-ui-7bd9b7c579-qtcdr   1/1   Running   0   3d22h   ...   app=admin-ui,pod-template-hash=7bd9b7c579
 */
function parsePodsList(raw: string): Array<{ name: string; namespace: string; labels: Record<string, string> }> {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  // Handle MCP content wrapping
  let content = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.content?.[0]?.text) content = parsed.content[0].text;
    else if (typeof parsed === "string") content = parsed;
  } catch { /* use raw text */ }

  const lines = content.split("\n").filter((l: string) => l.trim());
  if (lines.length < 2) return [];

  // Find header line and column positions
  const headerLine = lines[0];
  const namespaceIdx = headerLine.indexOf("NAMESPACE");
  const nameIdx = headerLine.indexOf("NAME");
  const labelsIdx = headerLine.indexOf("LABELS");

  if (nameIdx === -1) return [];

  const results: Array<{ name: string; namespace: string; labels: Record<string, string> }> = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Split by whitespace for structured fields
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;

    const namespace = namespaceIdx !== -1 ? parts[0] : "";
    // NAME is typically the 4th column (NAMESPACE, APIVERSION, KIND, NAME)
    const name = parts[3] ?? "";

    // LABELS is the last whitespace-separated field, containing comma-separated key=value pairs
    const labels: Record<string, string> = {};
    const lastField = parts[parts.length - 1];
    if (lastField && lastField !== "<none>" && lastField.includes("=")) {
      for (const pair of lastField.split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0) {
          labels[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      }
    }

    if (name) results.push({ name, namespace, labels });
  }

  return results;
}

/**
 * Find the Loki datasource UID by querying list_datasources.
 */
async function findLokiDatasourceUid(
  listDsTool: [string, Tool] | undefined,
  config: ValidateStepConfig,
): Promise<string | undefined> {
  if (!listDsTool) return undefined;

  try {
    const start = Date.now();
    const result = await listDsTool[1].execute!({}, {} as any);
    const duration = Date.now() - start;
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    config.onToolCall?.(listDsTool[0], {}, resultStr, duration, undefined, "validation");

    const dsData = unwrapMcpJson(result);
    const datasources = Array.isArray(dsData) ? dsData : dsData?.datasources ?? [];
    logger.debug(`list_datasources returned ${datasources.length} datasources`);

    const loki = datasources.find((ds: any) =>
      ds.type === "loki" || ds.typeName === "Loki" || ds.name?.toLowerCase().includes("loki")
    );
    if (loki?.uid) {
      logger.debug(`Found Loki datasource: uid=${loki.uid}, name=${loki.name}`);
      return loki.uid;
    }
    logger.warn(`No Loki datasource found in: ${JSON.stringify(datasources.map((d: any) => ({ name: d.name, type: d.type, uid: d.uid }))).slice(0, 500)}`);
  } catch (err) {
    logger.warn(`Failed to find Loki datasource: ${err}`);
  }

  return undefined;
}

async function buildLabelMap(
  labelNamesTool: [string, any] | undefined,
  labelValuesTool: [string, any] | undefined,
  lokiDsUid: string | undefined,
  config: ValidateStepConfig,
  labelKeys: string[] = SERVICE_LABEL_KEYS,
): Promise<Map<string, Map<string, string>>> {
  const map = new Map<string, Map<string, string>>();
  if (!labelNamesTool || !labelValuesTool || !lokiDsUid) return map;

  try {
    const start = Date.now();
    const namesResult = await labelNamesTool[1].execute!({ datasourceUid: lokiDsUid }, {} as any);
    const duration = Date.now() - start;
    const namesStr = typeof namesResult === "string" ? namesResult : JSON.stringify(namesResult);
    config.onToolCall?.(labelNamesTool[0], { datasourceUid: lokiDsUid }, namesStr, duration, undefined, "validation");

    const parsed = unwrapMcpJson(namesResult);
    const allNames: string[] = Array.isArray(parsed) ? parsed : parsed?.labels ?? parsed?.data ?? parsed?.values ?? [];
    logger.debug(`Available label names (${allNames.length}): ${allNames.slice(0, 30).join(", ")}`);

    const available = allNames.filter(
      (k: string) => labelKeys.some((p) => k === p || k.toLowerCase().includes(p)),
    );
    logger.debug(`Found ${available.length} matching label keys: ${available.join(", ")}`);

    for (const key of available) {
      try {
        const vStart = Date.now();
        const valResult = await labelValuesTool[1].execute!({ datasourceUid: lokiDsUid, labelName: key }, {} as any);
        const vDuration = Date.now() - vStart;
        const valStr = typeof valResult === "string" ? valResult : JSON.stringify(valResult);
        config.onToolCall?.(labelValuesTool[0], { labelName: key }, valStr, vDuration, undefined, "validation");

        const valParsed = unwrapMcpJson(valResult);
        const values: string[] = Array.isArray(valParsed) ? valParsed : valParsed?.values ?? valParsed?.data ?? [];
        // Store lowercase → original mapping for case-preserving label selectors
        const valueMap = new Map<string, string>();
        for (const v of values) valueMap.set(v.toLowerCase(), v);
        map.set(key, valueMap);
        logger.debug(`Label "${key}": ${values.length} values`);
      } catch { /* skip this label key */ }
    }
  } catch (err) {
    logger.warn(`Failed to build label map: ${err}`);
  }

  return map;
}

/**
 * Normalize a service name for fuzzy matching:
 * - lowercase
 * - strip common suffixes (-headless, -server, -svc, -service, -master, -metrics, -proxy)
 * - strip trailing digits and hyphens (e.g., "redis-ha-announce-0" → "redis-ha-announce")
 * - collapse repeated hyphens
 */
function normalizeName(name: string): string[] {
  const lower = name.toLowerCase();
  const variants = new Set<string>([lower]);

  // Strip common suffixes
  const suffixes = ["-headless", "-server", "-svc", "-service", "-master", "-metrics", "-proxy", "-internal", "-external"];
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) {
      variants.add(lower.slice(0, -suffix.length));
    }
  }

  // Strip trailing -N (numbered instances like redis-ha-announce-0)
  const noTrailingNum = lower.replace(/-\d+$/, "");
  if (noTrailingNum !== lower) variants.add(noTrailingNum);

  // Expand common abbreviations: svr→server, svc→service
  const expanded = lower
    .replace(/\bsvr\b/g, "server")
    .replace(/\bsvc\b/g, "service");
  if (expanded !== lower) variants.add(expanded);

  // Also try the abbreviated form of the full name
  const abbreviated = lower
    .replace(/\bserver\b/g, "svr")
    .replace(/\bservice\b/g, "svc");
  if (abbreviated !== lower) variants.add(abbreviated);

  return [...variants];
}

/**
 * For each service with empty logLabels, try to find a matching Loki label
 * by fuzzy-matching the service name against label values.
 *
 * Matching strategy (in priority order):
 * 1. Exact match on name or normalized variants
 * 2. namespace/name format match (for "job" labels)
 * 3. Substring containment — label value contains service name or vice versa
 */
function enrichLogLabels(
  services: ServiceConfig[],
  labelMap: Map<string, Map<string, string>>,
): ServiceConfig[] {
  if (labelMap.size === 0) return services;

  // Priority order: prefer specific label keys over generic ones
  const LABEL_PRIORITY = ["app", "service_name", "app_kubernetes_io_name", "job", "name",
    "app_kubernetes_io_component", "app_kubernetes_io_instance"];

  const sortedLabels = [...labelMap.entries()].sort(([a], [b]) => {
    const ai = LABEL_PRIORITY.indexOf(a);
    const bi = LABEL_PRIORITY.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  let enrichedCount = 0;

  const result = services.map((service) => {
    if (Object.keys(service.logLabels).length > 0) return service;

    const nameVariants = normalizeName(service.name);

    // Pass 1: Exact match on any normalized variant
    for (const [labelKey, valueMap] of sortedLabels) {
      for (const variant of nameVariants) {
        const original = valueMap.get(variant);
        if (original) {
          enrichedCount++;
          logger.debug(`Log label match: "${service.name}" → ${labelKey}="${original}" (exact)`);
          return { ...service, logLabels: { [labelKey]: original } };
        }
      }
    }

    // Pass 2: namespace/name format match (for job, job_name labels)
    for (const [labelKey, valueMap] of sortedLabels) {
      if (labelKey !== "job" && labelKey !== "job_name") continue;
      for (const [lowerVal, originalVal] of valueMap) {
        const parts = lowerVal.split("/");
        if (parts.length === 2) {
          for (const variant of nameVariants) {
            if (parts[1] === variant) {
              enrichedCount++;
              logger.debug(`Log label match: "${service.name}" → ${labelKey}="${originalVal}" (namespace/name)`);
              return { ...service, logLabels: { [labelKey]: originalVal } };
            }
          }
        }
      }
    }

    // Pass 3: Substring containment with similarity threshold
    // The shorter string must cover ≥60% of the longer string's length to avoid
    // false positives like "controller" matching "kube-controller-manager"
    for (const [labelKey, valueMap] of sortedLabels) {
      if (labelKey === "filename" || labelKey === "namespace" || labelKey === "batch_kubernetes_io_job_name") continue;
      for (const variant of nameVariants) {
        if (variant.length < 5) continue;
        for (const [lowerVal, originalVal] of valueMap) {
          if (lowerVal.length < 5) continue;
          if (lowerVal.includes(variant) || variant.includes(lowerVal)) {
            const shorter = Math.min(variant.length, lowerVal.length);
            const longer = Math.max(variant.length, lowerVal.length);
            if (shorter / longer >= 0.6) {
              enrichedCount++;
              logger.debug(`Log label match: "${service.name}" → ${labelKey}="${originalVal}" (substring, ${Math.round(shorter/longer*100)}% coverage)`);
              return { ...service, logLabels: { [labelKey]: originalVal } };
            }
          }
        }
      }
    }

    logger.debug(`No log label match for "${service.name}"`);
    return service;
  });

  logger.debug(`Log label enrichment: ${enrichedCount}/${services.length} services matched`);
  return result;
}

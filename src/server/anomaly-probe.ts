/**
 * anomaly-probe — deterministic PromQL + LogQL probe pass for scheduled system scans.
 *
 * Four-track evaluator (Slice C, 2026-04-22):
 *
 *   Origin          Source of rules                          MCP role
 *   ─────────────   ──────────────────────────────────────   ────────
 *   global          services.yaml globalProbeRules           metrics
 *                   (discovery-written, stack-aware)
 *   service         services.yaml .probeRules[] (metrics)    metrics
 *                   (e.g. pod_restarts for k8s workloads)
 *   service (logs)  services.yaml .probeRules[] (logs)       logs
 *                   (e.g. log_errors for services with logLabels)
 *   default         config.yaml ProbeSchema.metrics          metrics
 *                   (hardcoded k8s-native defaults from #115).
 *                   Only fires when global rules are empty.
 *
 *   +  logs fallback  count_over_time over logLabels         logs
 *                     when probe.logs.enabled, service has logLabels,
 *                     and no per-service logs rule was written.
 *
 * Operator per-service overrides (scan-service-override) still win —
 * `{disabled: true}` skips the service, `{rules: [...]}` replaces all
 * four tracks. consecutiveState keys are `${service}:${origin}:${ruleName}`
 * so rules with the same name on different tracks track hysteresis
 * independently (eng-review decision).
 *
 * Design doc: ~/.gstack/projects/WZ-dops-assistant/wli02-feat-llm-driven-probe-rules-design-20260422-continuation.md
 * Decisions:
 *   - Direct MCP tool invocation with AbortSignal — verified at
 *     node_modules/@mastra/mcp/dist/index.js:947. Real cancel.
 *   - Bounded concurrency via a simple semaphore — no p-limit dep.
 *   - NaN / empty vector → entry scored as "did not trip". Never throws.
 *   - Per-query queryTimeoutMs is belt-and-suspenders in case an MCP server
 *     ignores the abort signal.
 */

import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import { getToolsByRole } from "../mcp/provider.js";
import { parsePrometheusResult } from "./service-health-poller.js";
import type { ProbeConfig, ProbeMetricRule, Threshold } from "../config/schema.js";
import type { ScanServiceOverride } from "./scan-service-override.js";
import type { ServiceRegistryStore } from "../services/registry.js";

const logger = createLogger();

// AP6: Per-tick query budget. When the probe generates more than this many
// queries in a single tick, we emit a WARN log so operators notice
// cardinality growth before it floods the metrics backend. 200 is the
// observational threshold from /autoplan — chosen to trip at ~50 services
// with 4 rules each, below which most stacks comfortably sit.
const QUERY_BUDGET_WARN_THRESHOLD = 200;

// ── Types ───────────────────────────────────────────────────────────────────

/** Which track a hit came from. Included in the state key so same-named rules on different tracks keep independent hysteresis. */
export type RuleOrigin = "global" | "service" | "default" | "override" | "logs-fallback";

export interface ProbeHit {
  /** Service name (as known to the registry). */
  service: string;
  /** Rule name that tripped (e.g. "availability", "pod_restarts", "log_errors"). */
  ruleName: string;
  /** Which track the rule came from. Informational — already in the state key. */
  origin: RuleOrigin;
  /** Value returned by the rule's query. */
  value: number;
  /** The query string that produced this value (for the investigation message). */
  query: string;
  /** The threshold definition that was breached. */
  threshold: Threshold;
  /** How many consecutive ticks this rule has tripped (post-increment). */
  consecutiveTicks: number;
  /** Severity score: larger = more anomalous. Used for per-tick prioritization. */
  severity: number;
}

/**
 * Per-query outcome. `ok` carries a numeric scalar; `empty` means the query
 * succeeded but returned no rows (no data for this service/rule combo);
 * `error` means the MCP tool threw, timed out, or returned a parse-failing
 * payload. Value is always NaN for `empty` and `error` so scoring code that
 * treats NaN as no-trip keeps working.
 */
export type InstantOutcome = "ok" | "empty" | "error";
export interface InstantResult {
  kind: InstantOutcome;
  value: number;
}

/**
 * Per-service coverage snapshot emitted alongside the aggregate stats.
 * Lets the UI answer "which services had zero rules return data?" — a
 * structural blind spot where the rule templates don't match the service's
 * actual metric labels.
 */
export interface ServiceCoverage {
  service: string;
  rulesApplied: number;
  ok: number;
  empty: number;
  error: number;
}

/**
 * Return shape for runProbe. Carries the scored hits alongside stats that
 * feed the per-scan-run dashboard. `probeErrors` counts real MCP/parse
 * failures. `queriesEmpty` counts queries that succeeded but returned no
 * rows — most per-service rules on a healthy cluster fall here and it is
 * NOT an error condition. `coverage` carries the per-service breakdown
 * used by the detail pane.
 */
export interface ProbeResult {
  hits: ProbeHit[];
  queriesExecuted: number;
  probeErrors: number;
  queriesEmpty: number;
  coverage: ServiceCoverage[];
}

export interface ProbeOptions {
  services: string[];
  probe: ProbeConfig;
  providers: MastraProvider[];
  /** Prometheus datasource UID; if undefined, tick is aborted by the scheduler. */
  datasourceUid?: string;
  /**
   * Loki datasource UID for log-source rules. If undefined, log-source
   * rules and the probe.logs fallback both score NaN (no trip). Resolved
   * by the scheduler from provider metadata the same way datasourceUid is.
   */
  lokiDatasourceUid?: string;
  /** Abort signal — threaded through to the MCP tool invocation. */
  signal?: AbortSignal;
  /**
   * Per (service, origin, ruleName) state carrying how many consecutive
   * ticks each rule has exceeded its threshold. Caller owns the Map so the
   * scheduler can persist it across ticks.
   */
  consecutiveState: Map<string, number>;
  /**
   * Optional per-service operator override (scan-service-override). When
   * `disabled: true` the service is skipped entirely. When `rules` is
   * non-empty, those replace every track's rules for this service.
   * Getter form (not a pre-built Map) so the caller can cheaply re-read DB
   * each tick.
   */
  getOverride?: (service: string) => ScanServiceOverride | null;
  /**
   * Registry store — probe reads the atomic {services, globalProbeRules}
   * snapshot once per tick. Required so Track 1 (globals) and Track 2/3
   * (per-service probeRules) have a consistent view even if discovery
   * runs mid-tick.
   */
  registryStore: ServiceRegistryStore;
}

interface ToolExecutor {
  execute: (args: unknown, context?: { abortSignal?: AbortSignal }) => Promise<unknown>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Sanitize a service name for safe embedding in PromQL label selectors. */
function sanitizeForPromQL(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.\-]/g, "");
}

/**
 * State key for hysteresis. Namespaced by origin so a global "availability"
 * and a per-service "availability" with the same name track independently
 * (eng-review decision 2026-04-22). Exported for tests.
 */
export function stateKey(service: string, origin: RuleOrigin, ruleName: string): string {
  return `${service}:${origin}:${ruleName}`;
}

/**
 * Find a metric query tool from metrics-role tools. Matches the
 * service-health-poller pattern (same prefix/broadening heuristic) so that
 * adding a new Grafana-MCP-compatible tool automatically works in both places.
 */
function findMetricQueryTool(tools: Record<string, unknown>): ToolExecutor | null {
  for (const [name, tool] of Object.entries(tools)) {
    if (name.endsWith("query_prometheus") || name.endsWith("get_metrics")) {
      return tool as ToolExecutor;
    }
  }
  for (const [name, tool] of Object.entries(tools)) {
    const lower = name.toLowerCase();
    if ((lower.includes("query") || lower.includes("metric")) &&
        !lower.includes("loki") && !lower.includes("log") && !lower.includes("metadata")) {
      return tool as ToolExecutor;
    }
  }
  return null;
}

/**
 * Find a Loki query tool from logs-role tools. Canonical name in Grafana
 * MCP is `query_loki_logs`; also accepts generic log query tool names for
 * non-Loki log providers that may appear in the future.
 */
function findLogQueryTool(tools: Record<string, unknown>): ToolExecutor | null {
  for (const [name, tool] of Object.entries(tools)) {
    if (name.endsWith("query_loki_logs") || name.endsWith("query_logs")) {
      return tool as ToolExecutor;
    }
  }
  for (const [name, tool] of Object.entries(tools)) {
    const lower = name.toLowerCase();
    if (lower.includes("log") && lower.includes("query") && !lower.includes("metadata") && !lower.includes("label")) {
      return tool as ToolExecutor;
    }
  }
  return null;
}

/** Evaluate a numeric value against a threshold. NaN never trips. */
export function evaluateThreshold(value: number, t: Threshold): boolean {
  if (!Number.isFinite(value)) return false;
  switch (t.op) {
    case "gt":  return value >  t.value;
    case "gte": return value >= t.value;
    case "lt":  return value <  t.value;
    case "lte": return value <= t.value;
  }
}

/**
 * How "anomalous" a value is, scaled to a positive score for per-tick
 * prioritization. For gt/gte the excess above threshold; for lt/lte the
 * deficit below. Bounded by Math.abs to keep sort stable even when
 * threshold is 0.
 */
export function severityScore(value: number, t: Threshold): number {
  if (!Number.isFinite(value)) return 0;
  const delta = (t.op === "lt" || t.op === "lte") ? (t.value - value) : (value - t.value);
  const denom = Math.max(Math.abs(t.value), 1e-9);
  return Math.max(0, delta / denom);
}

// ── Bounded concurrency ─────────────────────────────────────────────────────

/** Run `tasks` with at most `n` in flight at a time. Preserves result order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  n: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Shared timeout + abort scaffolding ──────────────────────────────────────

/**
 * Wrap an MCP tool invocation with a timeout-bounded AbortController that is
 * also chained into the caller's signal. Never throws — returns `undefined`
 * on any failure (network error, timeout, aborted signal, MCP server
 * ignoring the abort). Each track's executor parses the returned raw value
 * into its own scalar.
 */
async function withTimeoutAndAbort(
  tool: ToolExecutor,
  args: unknown,
  signal: AbortSignal | undefined,
  queryTimeoutMs: number,
): Promise<unknown | undefined> {
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), queryTimeoutMs);
  // Chain the caller's signal into the timeout controller so an external
  // abort tears this down too. Belt-and-suspenders: if the MCP server
  // ignores abortSignal, the timeoutHandle still fires.
  const onExternalAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    return await tool.execute(args, { abortSignal: timeoutController.signal });
  } catch (err) {
    logger.warn({ err }, "anomaly-probe: tool invocation failed, scoring as no-trip");
    return undefined;
  } finally {
    clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}

/** Extract the first numeric scalar from a Prometheus-shaped result. NaN on miss. */
function scalarFromPromResult(raw: unknown): number {
  const entries = parsePrometheusResult(raw);
  if (entries.length === 0) return Number.NaN;
  const first = entries[0];
  if (!first) return Number.NaN;
  // Instant query shape: { value: [timestamp, "stringValue"] }
  if (first.value && Array.isArray(first.value) && first.value.length >= 2) {
    const parsed = parseFloat(String(first.value[1]));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  // Range query shape: { values: [[ts, "v"], ...] } — take the latest sample.
  if (first.values && Array.isArray(first.values) && first.values.length > 0) {
    const latest = first.values[first.values.length - 1];
    if (latest && latest.length >= 2) {
      const parsed = parseFloat(String(latest[1]));
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    }
  }
  return Number.NaN;
}

// ── Instant query executors (metrics + logs) ────────────────────────────────

/**
 * Execute one instant PromQL query via the metrics MCP tool. Never throws.
 * Returns a discriminated outcome so the caller can distinguish real MCP
 * failures from empty vectors (which are normal and expected whenever a
 * rule's labels don't match any active series).
 */
async function executeInstant(
  tool: ToolExecutor,
  query: string,
  datasourceUid: string | undefined,
  signal: AbortSignal | undefined,
  queryTimeoutMs: number,
): Promise<InstantResult> {
  const now = new Date();
  const args: Record<string, unknown> = {
    expr: query,
    queryType: "instant",
    startTime: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    endTime: now.toISOString(),
  };
  if (datasourceUid) args.datasourceUid = datasourceUid;
  const raw = await withTimeoutAndAbort(tool, args, signal, queryTimeoutMs);
  if (raw === undefined) return { kind: "error", value: Number.NaN };
  const value = scalarFromPromResult(raw);
  return Number.isFinite(value)
    ? { kind: "ok", value }
    : { kind: "empty", value: Number.NaN };
}

/**
 * Log-source executor: scalar count from a LogQL `count_over_time(...)`
 * query. Uses Grafana MCP `query_loki_logs` with `queryType: "metric"`,
 * which returns a metric vector (same shape Prometheus instant queries
 * return) rather than log lines. Never throws — NaN on failure, timeout,
 * or when the logs tool isn't wired.
 *
 * If the tool rejects `queryType: "metric"` (older Grafana MCP versions),
 * withTimeoutAndAbort catches the error and every log-source rule in the
 * tick silently scores NaN. The scan-scheduler tick log surfaces the
 * warning so operators notice and upgrade.
 */
async function executeInstantLogs(
  tool: ToolExecutor,
  query: string,
  lokiDatasourceUid: string | undefined,
  signal: AbortSignal | undefined,
  queryTimeoutMs: number,
): Promise<InstantResult> {
  // No Loki datasource wired is a config gap, not a query error. Treat as empty.
  if (!lokiDatasourceUid) return { kind: "empty", value: Number.NaN };
  const now = new Date();
  const args: Record<string, unknown> = {
    expr: query,
    queryType: "metric",
    datasourceUid: lokiDatasourceUid,
    startTime: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
    endTime: now.toISOString(),
  };
  const raw = await withTimeoutAndAbort(tool, args, signal, queryTimeoutMs);
  if (raw === undefined) return { kind: "error", value: Number.NaN };
  const value = scalarFromPromResult(raw);
  return Number.isFinite(value)
    ? { kind: "ok", value }
    : { kind: "empty", value: Number.NaN };
}

// ── Track assembly helpers ──────────────────────────────────────────────────

type Task = {
  service: string;
  rule: ProbeMetricRule;
  origin: RuleOrigin;
  query: string;
  usesLogs: boolean;
};

/**
 * Build the LogQL the probe.logs fallback uses: a basic
 * `count_over_time({labels} |= error|fatal [window])` over the service's
 * logLabels. Only called when the service has non-empty logLabels and no
 * per-service log-source rule was written.
 */
function buildGenericLogQLFromLabels(
  logLabels: Record<string, string>,
  windowStr: string,
): string {
  // Escape backslash FIRST so we don't double-escape the quotes we add next.
  // k8s label values are RFC 1123 so these escapes are belt-and-suspenders
  // — but logLabels ultimately come from discovery, which could include any
  // string a provider returns. Cheap to be defensive.
  const selectors = Object.entries(logLabels)
    .map(([k, v]) => {
      const escaped = v.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`);
      return `${k}="${escaped}"`;
    })
    .join(",");
  return `sum(count_over_time({${selectors}} |= \`error\` or \`fatal\` [${windowStr}]))`;
}

/** Parse probe.logs.window ("15m", "5m", "1h", "30s", "1d") → minutes. */
function parseWindowToMinutes(window: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(window.trim());
  if (!m) return 15;
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case "s": return n / 60;
    case "m": return n;
    case "h": return n * 60;
    case "d": return n * 60 * 24;
    default:  return 15;
  }
}

// ── Probe orchestration ─────────────────────────────────────────────────────

/**
 * Run the four-track probe pass. For each (service, rule, origin) triple,
 * fire one instant query and decide whether it trips. Consecutive-tick
 * state is updated per stateKey (reset on non-trip, incremented on trip).
 * Returns only rules that have tripped for at least their configured
 * `consecutiveTicks`.
 *
 * Partial failures are silent (scored as no-trip). An external abort ends
 * pending queries but does not throw — callers see an empty result and log
 * "tick aborted".
 */
export async function runProbe(opts: ProbeOptions): Promise<ProbeResult> {
  const { services, probe, providers, datasourceUid, lokiDatasourceUid, signal, consecutiveState, registryStore } = opts;

  if (services.length === 0) return { hits: [], queriesExecuted: 0, probeErrors: 0, queriesEmpty: 0, coverage: [] };

  // Atomic registry snapshot — one read per tick, consistent view of
  // services + globalProbeRules even if discovery runs concurrently.
  const registry = registryStore.loadAll();
  const serviceByName = new Map(registry.services.map((s) => [s.name, s] as const));

  // Resolve metrics MCP tool once per tick.
  let metricsTools: Record<string, unknown>;
  try {
    metricsTools = (await getToolsByRole(providers, "metrics")) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, "anomaly-probe: failed to resolve metrics MCP tools, skipping tick");
    return { hits: [], queriesExecuted: 0, probeErrors: 0, queriesEmpty: 0, coverage: [] };
  }
  const metricsTool = findMetricQueryTool(metricsTools);
  if (!metricsTool) {
    logger.warn("anomaly-probe: no metric query tool found, skipping tick");
    return { hits: [], queriesExecuted: 0, probeErrors: 0, queriesEmpty: 0, coverage: [] };
  }

  // Resolve logs MCP tool if available. Missing logs tool is NOT fatal —
  // metrics-source tracks continue; log-source tracks all score NaN.
  let logsTool: ToolExecutor | null = null;
  try {
    const logsTools = (await getToolsByRole(providers, "logs")) as Record<string, unknown>;
    logsTool = findLogQueryTool(logsTools);
  } catch {
    // getToolsByRole throws when no provider has the logs role — expected
    // on metrics-only deployments. Silently fall through.
  }

  // ── Build task list across all four tracks ──────────────────────────────
  const tasks: Task[] = [];
  const globalRules = registry.globalProbeRules;  // Track 1 — discovery-written
  const defaultRules = probe.metrics;             // Track 4 — config.yaml fallback
  const logWindowMinutes = parseWindowToMinutes(probe.logs.window);

  for (const service of services) {
    // Operator per-service override wins over every track.
    const override = opts.getOverride?.(service);
    if (override?.disabled) continue;
    if (override?.rules && override.rules.length > 0) {
      const safeService = sanitizeForPromQL(service);
      for (const rule of override.rules) {
        tasks.push({
          service,
          rule,
          origin: "override",
          query: rule.query.replaceAll("{service}", safeService),
          usesLogs: (rule.source ?? "metrics") === "logs",
        });
      }
      continue;
    }

    const safeService = sanitizeForPromQL(service);
    const serviceConfig = serviceByName.get(service);
    const perServiceRules = serviceConfig?.probeRules ?? [];

    // Track 1 vs 4 — discovery-written globals REPLACE the config.yaml
    // defaults for every service. Track 4 remains as the ultimate fallback
    // for stacks where discovery has never run.
    //
    // Redundancy suppression: when the service has its own
    // `service_availability` per-service rule, the base-track workload-type
    // probes (deployment/statefulset/daemonset availability) are
    // definitionally redundant — each service can only be ONE workload
    // kind, so two of the three default globals always return an empty
    // vector for it. That flood of empties is the single biggest source of
    // no-data noise in the scan run view. Skip the base track in that case
    // and let the per-service rule carry the availability signal.
    const hasOwnAvailability = perServiceRules.some((r) => r.name === "service_availability");
    const baseRules = hasOwnAvailability ? [] : (globalRules.length > 0 ? globalRules : defaultRules);
    const baseOrigin: RuleOrigin = globalRules.length > 0 ? "global" : "default";
    for (const rule of baseRules) {
      tasks.push({
        service,
        rule,
        origin: baseOrigin,
        query: rule.query.replaceAll("{service}", safeService),
        usesLogs: (rule.source ?? "metrics") === "logs",
      });
    }

    // Tracks 2 + 3 — per-service probeRules. Always additive to the base
    // track above; these are the rules only the discovery agent had enough
    // context to write (pod_restarts with real namespace, log_errors with
    // real Loki labels).
    for (const rule of perServiceRules) {
      tasks.push({
        service,
        rule,
        origin: "service",
        query: rule.query.replaceAll("{service}", safeService),
        usesLogs: (rule.source ?? "metrics") === "logs",
      });
    }

    // probe.logs generic fallback — fires only when (a) probe.logs is
    // enabled globally, (b) the service has logLabels, and (c) no
    // per-service log-source rule was written for this service.
    if (probe.logs.enabled) {
      const labels = serviceConfig?.logLabels;
      const hasLogLabels = labels && Object.keys(labels).length > 0;
      const alreadyHasLogRule = perServiceRules.some((r) => (r.source ?? "metrics") === "logs");
      if (hasLogLabels && !alreadyHasLogRule) {
        const query = buildGenericLogQLFromLabels(labels!, probe.logs.window);
        const threshold: Threshold = {
          op: "gt",
          // errorRateThreshold is per-minute; the query returns a raw count
          // over the window, so scale by window length.
          value: probe.logs.errorRateThreshold * logWindowMinutes,
        };
        tasks.push({
          service,
          rule: {
            name: "log_errors_fallback",
            query,
            threshold,
            consecutiveTicks: probe.logs.consecutiveTicks,
            source: "logs",
          },
          origin: "logs-fallback",
          query,
          usesLogs: true,
        });
      }
    }
  }

  // AP6: Probe query budget warning. Warn when a tick generates more than
  // 200 queries — stacks with many services and many per-service rules
  // silently cross this threshold and can flood the metrics backend. Not a
  // hard block; observability only so operators can notice cardinality
  // explosion early. Fires once per tick when tripped (no suppression) —
  // the scan scheduler runs on a bounded cadence, so WARN-per-tick is fine.
  if (tasks.length > QUERY_BUDGET_WARN_THRESHOLD) {
    logger.warn(
      {
        taskCount: tasks.length,
        threshold: QUERY_BUDGET_WARN_THRESHOLD,
        serviceCount: services.length,
        defaultMetricsCount: probe.metrics.length,
      },
      `anomaly-probe: probe tick generated ${tasks.length} queries (threshold ${QUERY_BUDGET_WARN_THRESHOLD}) — cardinality may be growing; check services × per-service rule counts`,
    );
  }

  // ── Garbage-collect orphaned consecutiveState entries ───────────────────
  // Discovery-driven rule changes (rename, remove, threshold rewrite) don't
  // currently fire `scan-scheduler.resetHysteresisForChangedRules` — that
  // hook only runs on config.yaml reload via PUT /api/scan/settings. Without
  // cleanup, renamed rules leak counters under the old state key (unbounded
  // Map growth across discovery re-runs), and removed rules keep their
  // counter forever. This tick-start GC is cheap (one Map diff) and covers
  // every rule-change case: discovery writes, config reloads, per-service
  // override toggles, hidden-service filtering. Operator-override and
  // disabled services naturally contribute zero tasks → their keys drop.
  const activeKeys = new Set(tasks.map((t) => stateKey(t.service, t.origin, t.rule.name)));
  let orphaned = 0;
  for (const key of Array.from(consecutiveState.keys())) {
    if (!activeKeys.has(key)) {
      consecutiveState.delete(key);
      orphaned++;
    }
  }
  if (orphaned > 0) {
    logger.debug({ orphaned, activeKeys: activeKeys.size }, "anomaly-probe: garbage-collected orphaned consecutiveState entries");
  }

  // ── Execute all tasks under one shared concurrency cap ──────────────────
  const results = await mapWithConcurrency<Task, InstantResult>(tasks, probe.concurrency, async (task) => {
    // External abort is not a query error — treat as empty so it doesn't
    // inflate the error count.
    if (signal?.aborted) return { kind: "empty", value: Number.NaN };
    // Log-source rule on a stack without a Loki datasource wired: config
    // gap, not a query failure.
    if (task.usesLogs) {
      if (!logsTool) return { kind: "empty", value: Number.NaN };
      return executeInstantLogs(logsTool, task.query, lokiDatasourceUid, signal, probe.logsQueryTimeoutMs);
    }
    return executeInstant(metricsTool, task.query, datasourceUid, signal, probe.queryTimeoutMs);
  });

  // ── Score: update consecutive-ticks state, collect qualifying hits ──────
  const hits: ProbeHit[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const result = results[i]!;
    const value = result.value;
    const key = stateKey(task.service, task.origin, task.rule.name);
    // AP4: Log at INFO when a rule scores NaN (empty vector, broken label
    // set, Loki datasource unwired, MCP error, timeout). The tick summary
    // already counts probeErrors and queriesEmpty in aggregate; this per-rule
    // line is what operators need to find the specific broken rule. Skip
    // for external aborts (task.signal aborted → kind "empty" but not
    // actionable) — `kind === "empty"` with a wired logs/metrics tool AND
    // a non-aborted signal is still interesting, so we don't filter on
    // abort here since abort already returns `kind: "empty"` with NaN.
    if (!Number.isFinite(value)) {
      logger.info(
        { service: task.service, ruleName: task.rule.name, origin: task.origin, kind: result.kind, query: task.query },
        `anomaly-probe: rule scored ${result.kind === "error" ? "error" : "empty vector"} — no trip (NaN)`,
      );
    }
    const tripped = evaluateThreshold(value, task.rule.threshold);

    if (!tripped) {
      // Reset hysteresis on any non-trip (including NaN).
      consecutiveState.delete(key);
      continue;
    }

    const count = (consecutiveState.get(key) ?? 0) + 1;
    consecutiveState.set(key, count);

    if (count >= task.rule.consecutiveTicks) {
      hits.push({
        service: task.service,
        ruleName: task.rule.name,
        origin: task.origin,
        value,
        query: task.query,
        threshold: task.rule.threshold,
        consecutiveTicks: count,
        severity: severityScore(value, task.rule.threshold),
      });
    }
  }

  // Split outcomes: real failures (MCP threw / timeout / parse-fail) are
  // surfaced as errors; empty vectors on a per-service rule are the common,
  // healthy no-match case and tracked separately so they don't poison the
  // error signal. Also build a per-service coverage map so the UI can flag
  // services whose rules all returned empty (structural blind spot).
  let probeErrors = 0;
  let queriesEmpty = 0;
  const coverageMap = new Map<string, ServiceCoverage>();
  for (let i = 0; i < results.length; i++) {
    const kind = results[i]!.kind;
    if (kind === "error") probeErrors++;
    else if (kind === "empty") queriesEmpty++;
    const svc = tasks[i]!.service;
    let cov = coverageMap.get(svc);
    if (!cov) {
      cov = { service: svc, rulesApplied: 0, ok: 0, empty: 0, error: 0 };
      coverageMap.set(svc, cov);
    }
    cov.rulesApplied++;
    if (kind === "ok") cov.ok++;
    else if (kind === "empty") cov.empty++;
    else cov.error++;
  }
  return {
    hits,
    queriesExecuted: tasks.length,
    probeErrors,
    queriesEmpty,
    coverage: Array.from(coverageMap.values()),
  };
}

/**
 * Rank hits for per-tick dispatch. Higher severity first; tiebreak by
 * "oldest last-investigated" (smallest timestamp first) to spread coverage.
 * Services with no prior investigation sort as oldest.
 */
export function prioritizeHits(
  hits: ProbeHit[],
  getLastInvestigationAt: (service: string) => number | null,
): ProbeHit[] {
  // Collapse to one hit per service (highest severity wins) — firing more than
  // one investigation for the same service in a single tick is wasteful; the
  // investigation itself will surface all the anomalies.
  const bestPerService = new Map<string, ProbeHit>();
  for (const hit of hits) {
    const existing = bestPerService.get(hit.service);
    if (!existing || hit.severity > existing.severity) {
      bestPerService.set(hit.service, hit);
    }
  }

  return [...bestPerService.values()].sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    const la = getLastInvestigationAt(a.service) ?? 0;
    const lb = getLastInvestigationAt(b.service) ?? 0;
    return la - lb;
  });
}

/**
 * Format a ProbeHit as the `message` passed to InvestigationRunner.run.
 * Mirrors the webhook-handler's enriched message shape so RCA quality stays
 * consistent with alert-driven investigations.
 */
export function buildInvestigationMessage(hit: ProbeHit): string {
  const opLabel = hit.threshold.op === "gt" ? ">"
    : hit.threshold.op === "gte" ? ">="
    : hit.threshold.op === "lt" ? "<"
    : "<=";
  return [
    `Proactive scan detected anomaly on ${hit.service}.`,
    `Rule: ${hit.ruleName} (observed ${hit.value} ${opLabel} threshold ${hit.threshold.value} for ${hit.consecutiveTicks} consecutive tick(s)).`,
    `Query: ${hit.query}`,
  ].join("\n");
}

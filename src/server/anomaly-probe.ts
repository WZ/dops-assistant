/**
 * anomaly-probe — deterministic PromQL probe pass for scheduled system scans.
 *
 * The probe is the "cheap" half of the proactive scan pipeline: it runs a small
 * set of PromQL queries against every registered service, scores each result
 * against configured thresholds, and returns the services that tripped. It
 * does NOT call the LLM. Scan-triggered investigations are fired separately,
 * only for services the probe flags (capped by maxInvestigationsPerTick).
 *
 * Design doc: ~/.gstack/projects/WZ-dops-assistant/wli02-main-design-20260421-012829.md
 * Decisions:
 *   - Direct MCP tool.execute(args, { abortSignal }) — verified at
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

const logger = createLogger();

// ── Types ───────────────────────────────────────────────────────────────────

export interface ProbeHit {
  /** Service name (as known to the registry). */
  service: string;
  /** Rule name that tripped (e.g. "availability", "error_rate"). */
  ruleName: string;
  /** Value returned by the rule's PromQL query. */
  value: number;
  /** The PromQL query that produced this value (for the investigation message). */
  query: string;
  /** The threshold definition that was breached. */
  threshold: Threshold;
  /** How many consecutive ticks this rule has tripped (post-increment). */
  consecutiveTicks: number;
  /** Severity score: larger = more anomalous. Used for per-tick prioritization. */
  severity: number;
}

export interface ProbeOptions {
  services: string[];
  probe: ProbeConfig;
  providers: MastraProvider[];
  /** Prometheus datasource UID; if undefined, tick is aborted by the scheduler. */
  datasourceUid?: string;
  /** Abort signal — passed through to MCP tool.execute. */
  signal?: AbortSignal;
  /**
   * Per (service, ruleName) state carrying how many consecutive ticks each
   * metric has exceeded its threshold. The probe reads, decides, and writes
   * back — caller owns the Map so scan-scheduler can persist it across ticks.
   */
  consecutiveState: Map<string, number>;
}

interface ToolExecutor {
  execute: (args: unknown, context?: { abortSignal?: AbortSignal }) => Promise<unknown>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Sanitize a service name for safe embedding in PromQL label selectors. */
function sanitizeForPromQL(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.\-]/g, "");
}

function stateKey(service: string, ruleName: string): string {
  return `${service}:${ruleName}`;
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

// ── PromQL execution ────────────────────────────────────────────────────────

/**
 * Execute one instant PromQL query via MCP. Returns the numeric scalar value
 * (first entry's sample), or NaN if the vector is empty / parse fails / timeout.
 * Never throws — errors are logged and returned as NaN.
 */
async function executeInstant(
  tool: ToolExecutor,
  query: string,
  datasourceUid: string | undefined,
  signal: AbortSignal | undefined,
  queryTimeoutMs: number,
): Promise<number> {
  const now = new Date();
  const args: Record<string, unknown> = {
    expr: query,
    queryType: "instant",
    startTime: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    endTime: now.toISOString(),
  };
  if (datasourceUid) args.datasourceUid = datasourceUid;

  // Belt-and-suspenders timeout: even with a real abort signal, some MCP servers
  // may ignore it. The race ensures the probe never wedges a tick longer than
  // queryTimeoutMs per query.
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), queryTimeoutMs);
  // Chain the caller's signal into the timeout controller so an external abort
  // tears this down too.
  const onExternalAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const raw = await tool.execute(args, { abortSignal: timeoutController.signal });
    const entries = parsePrometheusResult(raw);
    if (entries.length === 0) return Number.NaN;
    const first = entries[0];
    if (!first) return Number.NaN;
    // Instant query shape: { value: [timestamp, "stringValue"] }
    if (first.value && Array.isArray(first.value) && first.value.length >= 2) {
      const parsed = parseFloat(String(first.value[1]));
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    }
    // Range query shape: { values: [[ts, "v"], ...] } — take the latest sample
    if (first.values && Array.isArray(first.values) && first.values.length > 0) {
      const latest = first.values[first.values.length - 1];
      if (latest && latest.length >= 2) {
        const parsed = parseFloat(String(latest[1]));
        return Number.isFinite(parsed) ? parsed : Number.NaN;
      }
    }
    return Number.NaN;
  } catch (err) {
    logger.warn({ err, query }, "anomaly-probe: query failed, scoring as no-trip");
    return Number.NaN;
  } finally {
    clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}

// ── Probe orchestration ─────────────────────────────────────────────────────

/**
 * Run the probe pass: for each (service, rule) pair, fire one instant query
 * and decide whether it trips. Consecutive-tick state is updated per key
 * (reset on non-trip, incremented on trip). Returns only rules that have
 * tripped for at least their configured `consecutiveTicks`.
 *
 * Partial failures are silent (scored as no-trip). An external abort ends
 * pending queries but does not throw — callers see an empty result and log
 * "tick aborted".
 */
export async function runProbe(opts: ProbeOptions): Promise<ProbeHit[]> {
  const { services, probe, providers, datasourceUid, signal, consecutiveState } = opts;

  if (services.length === 0) return [];

  // Resolve metrics MCP tool once per tick
  let tools: Record<string, unknown>;
  try {
    tools = (await getToolsByRole(providers, "metrics")) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, "anomaly-probe: failed to resolve metrics MCP tools, skipping tick");
    return [];
  }

  const queryTool = findMetricQueryTool(tools);
  if (!queryTool) {
    logger.warn("anomaly-probe: no metric query tool found, skipping tick");
    return [];
  }

  // Build the (service, rule) work list
  type Task = { service: string; rule: ProbeMetricRule; query: string };
  const tasks: Task[] = [];
  for (const service of services) {
    const safeService = sanitizeForPromQL(service);
    for (const rule of probe.metrics) {
      tasks.push({
        service,
        rule,
        query: rule.query.replaceAll("{service}", safeService),
      });
    }
  }

  // Execute with bounded concurrency, signal plumbed through
  const values = await mapWithConcurrency(tasks, probe.concurrency, async (task) => {
    if (signal?.aborted) return Number.NaN;
    return executeInstant(queryTool, task.query, datasourceUid, signal, probe.queryTimeoutMs);
  });

  // Score: update consecutive-ticks state, collect hits that met consecutive requirement
  const hits: ProbeHit[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const value = values[i]!;
    const key = stateKey(task.service, task.rule.name);
    const tripped = evaluateThreshold(value, task.rule.threshold);

    if (!tripped) {
      // Reset hysteresis on any non-trip (including NaN)
      consecutiveState.delete(key);
      continue;
    }

    const count = (consecutiveState.get(key) ?? 0) + 1;
    consecutiveState.set(key, count);

    if (count >= task.rule.consecutiveTicks) {
      hits.push({
        service: task.service,
        ruleName: task.rule.name,
        value,
        query: task.query,
        threshold: task.rule.threshold,
        consecutiveTicks: count,
        severity: severityScore(value, task.rule.threshold),
      });
    }
  }

  return hits;
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

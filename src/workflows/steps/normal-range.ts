/**
 * Normal-range check for symptom metrics.
 *
 * Agents compare a reading against one "baseline" value, which cannot tell a
 * real spike from a service's ordinary swing (a shared model server's p99
 * latency can move 40s → 400s within an hour). This re-runs each elevated
 * symptom metric's own PromQL and compares its worst value in the
 * investigation window with its distribution over the previous 24h. Both
 * sides come from the same expression, so units never need parsing.
 *
 * Only symptoms count (latency, errors, restarts, availability). Workload
 * metrics (request, token, call rates) describe load, not damage: unusual
 * load with every symptom inside its normal range is not an incident.
 */

type Direction = "higher-is-worse" | "lower-is-worse";

/**
 * Slack around the 24h band. A flat metric (inter-token latency at 24.9ms) sits
 * at its own p95, so without it any jitter reads as "outside normal".
 */
const NORMAL_RANGE_TOLERANCE = 0.1;

/** Bounds the Prometheus calls (two per symptom) a synthesis step can spend here. */
const MAX_SYMPTOM_QUERIES = 6;

/** Labels the metrics agent uses for an observation it considers abnormal. */
const ELEVATED_SEVERITIES = new Set(["medium", "high", "warning", "critical"]);

export function symptomDirection(expr: string): Direction | null {
  const e = expr.toLowerCase();
  // "success" alone is a throughput counter that dips to 0 when idle; only a ratio is availability.
  if (/(available|ready|success_(rate|ratio)|success_percent|(^|[^a-z_])up\{)/.test(e)) return "lower-is-worse";
  if (/(latency|duration|error|fail|restart|oom|evict|code=~?"5)/.test(e)) return "higher-is-worse";
  return null;
}

/**
 * PromQL the metrics phase actually executed, taken from its tool calls rather
 * than from the model's description of them (observations often carry a name
 * like "e2e_request_latency_p99" instead of the query).
 */
export function executedPromQl(toolCalls: Array<{ tool?: string; args?: string }> | undefined): string[] {
  const out: string[] = [];
  for (const call of toolCalls ?? []) {
    if (!call.tool?.includes("query_prometheus") || !call.args) continue;
    try {
      const expr = (JSON.parse(call.args) as { expr?: unknown }).expr;
      if (typeof expr === "string" && expr.trim()) out.push(expr.trim());
    } catch { /* unparsable args: skip */ }
  }
  return out;
}

/** PromQL only — the metrics agent sometimes records a LogQL query as an observation. */
function isPromQl(expr: string): boolean {
  return /[({]/.test(expr) && !/\|[=~]/.test(expr) && !/^\s*loki\b/i.test(expr);
}

export interface NormalRangeCheck {
  metric: string;
  direction: Direction;
  worst: number;
  band: number;
  within: boolean;
}

export interface NormalRangeResult {
  checks: NormalRangeCheck[];
  /** Every elevated symptom metric stayed inside its previous-24h band. */
  allWithin: boolean;
}

/**
 * Null when nothing can be concluded: no elevated symptom metric, a window
 * that isn't absolute timestamps, or any query that returned no value.
 */
export async function checkSymptomsAgainstNormalRange(
  observations: Array<{ metric: string; severity: string }>,
  window: { from?: string; to?: string } | undefined,
  queryValue: (expr: string) => Promise<number | null>,
  now: number = Date.now(),
  executedQueries: string[] = [],
): Promise<NormalRangeResult | null> {
  const from = Date.parse(window?.from ?? "");
  const to = Date.parse(window?.to ?? "");
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;

  // Elevated observations that are PromQL, plus every symptom query the phase
  // ran: a healthy one stays inside its band, so including it only matters
  // when something really is outside its normal range.
  const flagged = observations
    .filter((o) => ELEVATED_SEVERITIES.has(String(o.severity).toLowerCase()) && isPromQl(o.metric))
    .map((o) => o.metric.trim());
  const flaggedSet = new Set(flagged);
  const symptoms = [...new Set([...flagged, ...executedQueries.filter(isPromQl).map((q) => q.trim())])]
    .map((metric) => ({ metric, direction: symptomDirection(metric), flagged: flaggedSet.has(metric) }))
    .filter((o): o is { metric: string; direction: Direction; flagged: boolean } => o.direction !== null)
    .slice(0, MAX_SYMPTOM_QUERIES);
  if (symptoms.length === 0) return null;

  const windowSecs = Math.max(60, Math.round((to - from) / 1000));
  const offset = (ms: number) => {
    const secs = Math.round((now - ms) / 1000);
    return secs > 0 ? ` offset ${secs}s` : "";
  };

  const checks: NormalRangeCheck[] = [];
  for (const { metric, direction, flagged: wasFlagged } of symptoms) {
    const higher = direction === "higher-is-worse";
    const worstExpr = higher
      ? `max(max_over_time((${metric})[${windowSecs}s:1m]${offset(to)}))`
      : `min(min_over_time((${metric})[${windowSecs}s:1m]${offset(to)}))`;
    const bandExpr = higher
      ? `max(quantile_over_time(0.95, (${metric})[24h:5m]${offset(from)}))`
      : `min(quantile_over_time(0.05, (${metric})[24h:5m]${offset(from)}))`;
    const [worst, band] = await Promise.all([queryValue(worstExpr), queryValue(bandExpr)]);
    if (worst === null || band === null || !Number.isFinite(worst) || !Number.isFinite(band)) {
      // A flagged symptom with no data means we cannot vouch for it; a query the
      // model merely ran, with no series, has nothing to compare and is skipped.
      if (wasFlagged) return null;
      continue;
    }
    const within = higher ? worst <= band * (1 + NORMAL_RANGE_TOLERANCE) : worst >= band * (1 - NORMAL_RANGE_TOLERANCE);
    checks.push({ metric, direction, worst, band, within });
  }
  if (checks.length === 0) return null;
  return { checks, allWithin: checks.every((c) => c.within) };
}

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : Number(n.toPrecision(3)).toString());

export function normalRangeNote(result: NormalRangeResult): string {
  const parts = result.checks.map((c) => c.direction === "higher-is-worse"
    ? `${c.metric} peaked at ${fmt(c.worst)}, 24h p95 ${fmt(c.band)}`
    : `${c.metric} dipped to ${fmt(c.worst)}, 24h p5 ${fmt(c.band)}`);
  return `Note: every symptom metric stayed at or near this service's normal range over the previous 24h (${parts.join("; ")}).`;
}

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

/** Labels the metrics agent uses for an observation it considers abnormal. */
const ELEVATED_SEVERITIES = new Set(["medium", "high", "warning", "critical"]);

export function symptomDirection(expr: string): Direction | null {
  const e = expr.toLowerCase();
  if (/(available|ready|success|(^|[^a-z_])up\{)/.test(e)) return "lower-is-worse";
  if (/(latency|duration|error|fail|restart|oom|evict|code=~?"5)/.test(e)) return "higher-is-worse";
  return null;
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
): Promise<NormalRangeResult | null> {
  const from = Date.parse(window?.from ?? "");
  const to = Date.parse(window?.to ?? "");
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;

  const symptoms = observations
    .filter((o) => ELEVATED_SEVERITIES.has(String(o.severity).toLowerCase()) && isPromQl(o.metric))
    .map((o) => ({ metric: o.metric.trim(), direction: symptomDirection(o.metric) }))
    .filter((o): o is { metric: string; direction: Direction } => o.direction !== null);
  if (symptoms.length === 0) return null;

  const windowSecs = Math.max(60, Math.round((to - from) / 1000));
  const offset = (ms: number) => {
    const secs = Math.round((now - ms) / 1000);
    return secs > 0 ? ` offset ${secs}s` : "";
  };

  const checks: NormalRangeCheck[] = [];
  for (const { metric, direction } of symptoms) {
    const higher = direction === "higher-is-worse";
    const worstExpr = higher
      ? `max(max_over_time((${metric})[${windowSecs}s:1m]${offset(to)}))`
      : `min(min_over_time((${metric})[${windowSecs}s:1m]${offset(to)}))`;
    const bandExpr = higher
      ? `max(quantile_over_time(0.95, (${metric})[24h:5m]${offset(from)}))`
      : `min(quantile_over_time(0.05, (${metric})[24h:5m]${offset(from)}))`;
    const [worst, band] = await Promise.all([queryValue(worstExpr), queryValue(bandExpr)]);
    if (worst === null || band === null || !Number.isFinite(worst) || !Number.isFinite(band)) return null;
    checks.push({ metric, direction, worst, band, within: higher ? worst <= band : worst >= band });
  }
  return { checks, allWithin: checks.every((c) => c.within) };
}

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : Number(n.toPrecision(3)).toString());

export function normalRangeNote(result: NormalRangeResult): string {
  const parts = result.checks.map((c) => c.direction === "higher-is-worse"
    ? `${c.metric} peaked at ${fmt(c.worst)}, 24h p95 ${fmt(c.band)}`
    : `${c.metric} dipped to ${fmt(c.worst)}, 24h p5 ${fmt(c.band)}`);
  return `Severity capped at low: every elevated symptom stayed within this service's normal range over the previous 24h (${parts.join("; ")}).`;
}

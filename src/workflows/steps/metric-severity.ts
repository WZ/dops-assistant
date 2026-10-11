/**
 * Metric observation severities come from a model that was never given a
 * vocabulary, so the same reading arrives as "critical", "high", "medium",
 * "info" or "normal". The rest of the pipeline (severity validation, damage
 * checks) reads the declared three: normal | warning | critical.
 *
 * Only explicit critical-class words map to critical; "high" and "medium" mean
 * elevated, so they map to warning, which keeps a strongly-worded latency
 * reading from reading as damage.
 */
export type MetricSeverity = "normal" | "warning" | "critical";

const CRITICAL = new Set(["critical", "crit", "severe", "fatal", "major"]);
const WARNING = new Set(["warning", "warn", "high", "medium", "elevated", "moderate", "degraded"]);

export function normalizeMetricSeverity(raw: unknown): MetricSeverity {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (CRITICAL.has(value)) return "critical";
  if (WARNING.has(value)) return "warning";
  return "normal";
}

export function normalizeMetricObservations<T extends { severity?: unknown }>(observations: T[]): Array<T & { severity: MetricSeverity }> {
  return observations.map((o) => ({ ...o, severity: normalizeMetricSeverity(o.severity) }));
}

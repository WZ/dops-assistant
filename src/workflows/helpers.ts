import type { MetricFindings, LogFindings, InfraFindings } from "../types/rca-types.js";

/**
 * Build a chronological timeline from structured findings.
 * Programmatic — no LLM call needed.
 */
export function buildTimeline(
  metrics: MetricFindings,
  logs: LogFindings,
  infra: InfraFindings,
): string {
  const events: Array<{ time: string; source: string; detail: string }> = [];

  for (const obs of metrics.observations ?? []) {
    if (obs.timestamp) {
      events.push({
        time: obs.timestamp,
        source: "metric",
        detail: `${obs.metric}: ${obs.currentValue} (baseline: ${obs.baselineValue})`,
      });
    }
  }
  for (const obs of logs.observations ?? []) {
    if (obs.firstSeen) {
      events.push({
        time: obs.firstSeen,
        source: "log",
        detail: `${obs.pattern} (count: ${obs.count})`,
      });
    }
  }
  for (const obs of infra.observations ?? []) {
    if (obs.timestamp) {
      events.push({
        time: obs.timestamp,
        source: "infra",
        detail: `${obs.resource}: ${obs.status}`,
      });
    }
  }

  events.sort((a, b) => {
    const ta = Date.parse(a.time);
    const tb = Date.parse(b.time);
    const aValid = !Number.isNaN(ta);
    const bValid = !Number.isNaN(tb);
    if (aValid && bValid) return ta - tb;
    if (aValid) return -1;
    if (bValid) return 1;
    return a.time.localeCompare(b.time);
  });
  return events.map((e) => `[${e.time}] [${e.source}] ${e.detail}`).join("\n");
}

/**
 * Deterministic severity validator.
 * Checks whether the LLM-assigned severity is consistent with the actual findings.
 * Returns a corrected severity if the LLM got it wrong, or null if it's fine.
 *
 * Key rule: if all evidence summaries indicate "no anomaly" / "normal" / "stable"
 * and metric observations are all "normal" severity, the report severity must be "low".
 */
export function validateSeverity(
  report: { severity: string; summary: string; rootCause: string },
  metrics: MetricFindings,
  logs: LogFindings,
  infra: InfraFindings,
): "low" | "medium" | "high" | "critical" | null {
  // Patterns that indicate everything is normal
  const normalPatterns = /\b(no anomal\w*|normal\w*|stable|steady|within.{0,20}(range|limit|band|baseline|expect)|no.{0,20}(spike|drop|outage|issue|incident|degradation|error)|healthy|expected|no abnormal)\b/i;

  const summaryNormal = normalPatterns.test(report.summary);
  const rootCauseNormal = normalPatterns.test(report.rootCause);
  const metricSummaryNormal = normalPatterns.test(metrics.summary);
  const logSummaryNormal = normalPatterns.test(logs.summary);
  const infraSummaryNormal = normalPatterns.test(infra.summary);

  // Check if any metric observations have warning/critical severity
  const hasElevatedMetrics = metrics.observations.some(
    (o) => o.severity === "warning" || o.severity === "critical",
  );

  // If the report's own summary and root cause say "no anomaly" but severity is elevated — override
  if (summaryNormal && rootCauseNormal && !hasElevatedMetrics) {
    if (report.severity !== "low") {
      return "low";
    }
  }

  // If all three phase summaries say normal and no elevated metrics — override
  if (metricSummaryNormal && logSummaryNormal && infraSummaryNormal && !hasElevatedMetrics) {
    if (report.severity !== "low") {
      return "low";
    }
  }

  return null; // severity is fine
}

/**
 * Extract a Grafana-compatible time range from the anomaly description.
 * Uses Grafana's day-rounding syntax (/d) to produce precise day boundaries.
 * This is a static regex-based fallback — use LLM extraction for complex natural language.
 */
export function extractTimeRange(anomalySummary: string, userMessage?: string): { from: string; to: string } {
  // Lightweight fallback for when LLM extraction fails or is skipped.
  const text = `${anomalySummary} ${userMessage ?? ""}`.toLowerCase().replace(/[\u2010-\u2015\u2212]/g, "-");

  // 1. Exact ISO date (e.g. "2026-03-04")
  const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    return { from: `${dateMatch[1]}T00:00:00Z`, to: `${dateMatch[1]}T23:59:59Z` };
  }

  // 2. Named month + day (e.g. "March 4", "Jan 15") — resolve to current year
  const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const monthDayMatch = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/i);
  if (monthDayMatch) {
    const monthKey = monthDayMatch[1].slice(0, 3).toLowerCase();
    const month = MONTHS[monthKey];
    const day = parseInt(monthDayMatch[2], 10);
    if (month !== undefined && day >= 1 && day <= 31) {
      const year = new Date().getFullYear();
      const d = new Date(year, month, day);
      if (d.getMonth() !== month) {
        // Invalid date (e.g., Feb 30) — fall through to relative patterns
      } else {
        if (d > new Date()) d.setFullYear(year - 1);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return { from: `${iso}T00:00:00Z`, to: `${iso}T23:59:59Z` };
      }
    }
  }

  // 3. Common relative expressions
  if (/last\s+(week|7\s*d)/i.test(text)) return { from: "now-7d", to: "now" };
  if (/yesterday/i.test(text)) return { from: "now-1d", to: "now" };
  if (/last\s+(month|30\s*d)/i.test(text)) return { from: "now-30d", to: "now" };
  if (/last\s+(24|twenty.?four)\s*h/i.test(text)) return { from: "now-24h", to: "now" };
  if (/last\s+(\d+)\s*d(?:ays?)?(?:\s|$)/i.test(text)) {
    const days = text.match(/last\s+(\d+)\s*d(?:ays?)?(?:\s|$)/i)![1];
    return { from: `now-${days}d`, to: "now" };
  }

  // 4. Default fallback
  return { from: "now-8h", to: "now" };
}

/**
 * Resolve a time range to absolute UTC ISO strings.
 * Handles both absolute ISO dates (pass-through) and Grafana-relative expressions
 * ("now-7d", "now"). Use this when persisting time ranges to report metadata —
 * relative strings are meaningless after the investigation completes.
 */
export function resolveTimeRangeToAbsolute(range: { from: string; to: string }): { from: string; to: string } {
  const resolve = (expr: string): string => {
    // Already absolute ISO
    if (/^\d{4}-\d{2}-\d{2}/.test(expr)) return new Date(expr).toISOString();
    // Grafana-relative: "now", "now-1h", "now-7d", etc.
    const m = expr.match(/^now(?:-(\d+)([smhdw]))?/);
    if (m) {
      const d = new Date();
      if (m[1] && m[2]) {
        const n = parseInt(m[1], 10);
        const multipliers: Record<string, () => void> = {
          s: () => d.setSeconds(d.getSeconds() - n),
          m: () => d.setMinutes(d.getMinutes() - n),
          h: () => d.setHours(d.getHours() - n),
          d: () => d.setDate(d.getDate() - n),
          w: () => d.setDate(d.getDate() - n * 7),
        };
        multipliers[m[2]]?.();
      }
      return d.toISOString();
    }
    // Unknown format — return as-is (shouldn't happen)
    return expr;
  };
  return { from: resolve(range.from), to: resolve(range.to) };
}

/** Suggest step size for Prometheus range queries. Aims for ~100 data points. */
export function suggestStepSeconds(window: { from: string; to: string }): number {
  try {
    const parseTimeExpr = (expr: string): Date => {
      if (/^\d{4}-\d{2}-\d{2}/.test(expr)) return new Date(expr);
      const m = expr.match(/^now(?:-(\d+)([smhdw]))?(?:\/d)?$/);
      const d = new Date();
      if (m) {
        const amount = m[1] ? parseInt(m[1], 10) : 0;
        const unit = m[2];
        if (amount > 0 && unit) {
          switch (unit) {
            case "s": d.setSeconds(d.getSeconds() - amount); break;
            case "m": d.setMinutes(d.getMinutes() - amount); break;
            case "h": d.setHours(d.getHours() - amount); break;
            case "d": d.setDate(d.getDate() - amount); break;
            case "w": d.setDate(d.getDate() - amount * 7); break;
          }
        }
        return d;
      }
      return d;
    };
    const from = parseTimeExpr(window.from);
    const to = parseTimeExpr(window.to);
    const durationSec = Math.abs(to.getTime() - from.getTime()) / 1000;
    if (durationSec > 0 && Number.isFinite(durationSec)) {
      return Math.max(300, Math.round(durationSec / 100));
    }
  } catch { /* fall through */ }
  return 900;
}

/** Convert time window to RFC3339 for Loki. Handles ISO dates and "now-Xd" relative expressions. */
export function toRfc3339Window(window: { from: string; to: string }): { startRfc3339: string; endRfc3339: string } {
  const resolve = (expr: string): string => {
    if (/^\d{4}-\d{2}-\d{2}/.test(expr)) return new Date(expr).toISOString();
    const m = expr.match(/^now(?:-(\d+)([dhm]))?/);
    if (m) {
      const d = new Date();
      if (m[1] && m[2]) {
        const n = parseInt(m[1], 10);
        if (m[2] === "d") d.setDate(d.getDate() - n);
        else if (m[2] === "h") d.setHours(d.getHours() - n);
        else d.setMinutes(d.getMinutes() - n);
      }
      return d.toISOString();
    }
    return new Date(Date.now() - 7 * 86400000).toISOString();
  };
  return { startRfc3339: resolve(window.from), endRfc3339: resolve(window.to) };
}

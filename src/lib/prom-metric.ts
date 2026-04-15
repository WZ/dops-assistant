/**
 * Pure PromQL metric expression parsing.
 * Stack-agnostic — imported by both the Node server (metric-extraction.ts)
 * and the web bundle (MetricsPanel.tsx) so they can't drift.
 */

/** Bare metric name, optionally followed by a label selector and range. */
const PROM_BARE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?(\[\d+[smhdwy]\])?/;

/** Leading aggregation function ("sum(", "rate(", etc.) */
const AGG_FN_RE = /^(sum|avg|max|min|count|rate|irate|increase|histogram_quantile)\s*\(/;

/** Return text[start..end] slice starting at '(' and ending at the matching ')'.
 *  Returns undefined if the parens aren't balanced within `text`. */
function sliceBalancedParens(text: string, start: number): string | undefined {
  if (text[start] !== "(") return undefined;
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** True if `s` looks like a real PromQL metric name (contains `_` or `:` OR
 *  has a label selector). Filters out plain English words that happen to
 *  match the identifier regex like "up", "was", "the". */
function looksLikeMetric(name: string, hasSelector: boolean): boolean {
  return hasSelector || /[_:]/.test(name);
}

/**
 * Extract a concrete PromQL metric expression from an observation string.
 *
 * Handles (in order of preference):
 *   1. Aggregation-wrapped:  `sum(http_requests_total{code="500"}) was high`
 *                            → `sum(http_requests_total{code="500"})`
 *   2. Rate with range:      `rate(http_requests_total[5m]) spiked`
 *                            → `rate(http_requests_total[5m])`
 *   3. Bare + selector:      `kube_deployment_status_replicas{deployment="x"} was 13`
 *                            → `kube_deployment_status_replicas{deployment="x"}`
 *   4. Bare metric:          `http_requests_total was elevated`
 *                            → `http_requests_total`
 *
 * Returns undefined for plain English that happens to match the identifier
 * regex ("up was 0", "the service was down").
 */
export function extractMetricExpression(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Path 1: aggregation wrapper. Preserve the full `fn(...)` call so the
  // chart-backfill query matches what the observation actually described.
  const aggMatch = trimmed.match(AGG_FN_RE);
  if (aggMatch) {
    const fn = aggMatch[1]!;
    // position of the `(` is at aggMatch[0].length - 1
    const call = sliceBalancedParens(trimmed, aggMatch[0].length - 1);
    if (call) {
      const inner = call.slice(1, -1).trim();
      const innerMetric = inner.match(PROM_BARE_RE);
      if (innerMetric && looksLikeMetric(innerMetric[1]!, !!innerMetric[2])) {
        return `${fn}${call}`;
      }
    }
    // Aggregation opened but no real metric inside — fall through to bare.
  }

  // Path 2: bare metric, with optional selector and range.
  const m = trimmed.match(PROM_BARE_RE);
  if (!m) return undefined;
  const metricName = m[1]!;
  const selector = m[2] ?? "";
  const range = m[3] ?? "";
  if (!looksLikeMetric(metricName, !!selector)) return undefined;
  return `${metricName}${selector}${range}`;
}

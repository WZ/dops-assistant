import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import { queryServiceMetrics, type MetricSeries } from "./prometheus-query.js";
import { extractMetricExpression } from "../lib/prom-metric.js";

export { extractMetricExpression };

const logger = createLogger();

export interface MetricHints {
  keywords: string[];
  timeRef?: string;
  timeRefEnd?: string;
}

const METRIC_KEYWORDS = [
  "cpu", "memory", "error", "latency", "request",
  "connection", "disk", "queue", "throughput", "rate",
  "replica", "pod", "restart", "oom", "timeout",
] as const;

const TIME_PATTERN = /\b(\d{1,2}:\d{2})\b/g;
const TIME_RANGE_PATTERN = /between\s+(\d{1,2}:\d{2})\s+and\s+(\d{1,2}:\d{2})/i;

export function parseMetricHints(text: string): MetricHints {
  const lower = text.toLowerCase();
  // Match keywords as substrings (word-boundary was brittle: it failed on
  // plurals like "replicas" and on underscore-embedded names like
  // kube_pod_status_phase because underscores are word chars in JS regex).
  const keywords = METRIC_KEYWORDS.filter(kw => lower.includes(kw));

  let timeRef: string | undefined;
  let timeRefEnd: string | undefined;

  const rangeMatch = text.match(TIME_RANGE_PATTERN);
  if (rangeMatch) {
    timeRef = rangeMatch[1];
    timeRefEnd = rangeMatch[2];
  } else {
    const timeMatches = [...text.matchAll(TIME_PATTERN)];
    if (timeMatches.length > 0) {
      timeRef = timeMatches[0]![1];
      if (timeMatches.length > 1) {
        timeRefEnd = timeMatches[1]![1];
      }
    }
  }

  return { keywords, timeRef, timeRefEnd };
}

function keywordsToQueries(keywords: string[], serviceName: string): { query: string; description: string }[] {
  const safe = serviceName.replace(/[^a-zA-Z0-9_.\-]/g, "");
  const queries: { query: string; description: string }[] = [];

  for (const kw of keywords) {
    switch (kw) {
      case "cpu":
        queries.push({ query: `rate(container_cpu_usage_seconds_total{pod=~".*${safe}.*"}[5m])`, description: "CPU Usage" });
        break;
      case "memory":
      case "oom":
        queries.push({ query: `container_memory_working_set_bytes{pod=~".*${safe}.*"}`, description: "Memory Usage" });
        break;
      case "error":
      case "rate":
        queries.push({ query: `sum(rate(http_requests_total{service=~".*${safe}.*",code=~"5.."}[5m]))`, description: "Error Rate" });
        break;
      case "latency":
      case "timeout":
        queries.push({ query: `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{service=~".*${safe}.*"}[5m])) by (le))`, description: "Latency P99" });
        break;
      case "request":
      case "throughput":
        queries.push({ query: `sum(rate(http_requests_total{service=~".*${safe}.*"}[5m]))`, description: "Request Rate" });
        break;
      case "connection":
        queries.push({ query: `sum(pg_stat_activity_count{datname=~".*${safe}.*"})`, description: "Active Connections" });
        break;
      case "disk":
        queries.push({ query: `container_fs_usage_bytes{pod=~".*${safe}.*"}`, description: "Disk Usage" });
        break;
      case "queue":
        queries.push({ query: `sum(kafka_consumer_lag{group=~".*${safe}.*"})`, description: "Queue Lag" });
        break;
      case "replica":
      case "pod":
      case "restart":
        queries.push({ query: `kube_deployment_status_replicas{deployment=~".*${safe}.*"}`, description: "Pod Replicas" });
        break;
    }
  }

  const seen = new Set<string>();
  return queries.filter(q => {
    if (seen.has(q.query)) return false;
    seen.add(q.query);
    return true;
  });
}

export async function extractMetricsFromText(
  text: string,
  service: string,
  providers: MastraProvider[],
  timeRange?: { from: string; to: string },
): Promise<MetricSeries[]> {
  // Primary path: if the observation starts with a real PromQL metric
  // expression (what the LLM actually writes when it emits structured metric
  // findings), use it directly. This is the common case for LLM-generated
  // metric observations and sidesteps the brittle keyword translation.
  const directExpr = extractMetricExpression(text);
  const queries: { query: string; description: string }[] = [];

  if (directExpr) {
    queries.push({ query: directExpr, description: directExpr });
  } else {
    // Fallback: keyword-based heuristic for free-text observations like
    // "CPU spiked to 95% between 08:30 and 09:00".
    const hints = parseMetricHints(text);
    if (hints.keywords.length === 0) return [];
    queries.push(...keywordsToQueries(hints.keywords, service));
    if (queries.length === 0) return [];
  }

  const range = "1h";

  try {
    const series = await queryServiceMetrics(service, range, providers, queries);
    // When we extracted a direct expression, keep only series that actually
    // match it — queryServiceMetrics also runs default queries we don't care
    // about in this path.
    if (directExpr) {
      return series.filter(s => s.query === directExpr);
    }
    return series;
  } catch (err) {
    logger.warn({ err, text, service }, "metric-extraction: failed to query Prometheus");
    return [];
  }
}

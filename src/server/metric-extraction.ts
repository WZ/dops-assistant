import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import { queryServiceMetrics, type MetricSeries } from "./prometheus-query.js";

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
  const keywords = METRIC_KEYWORDS.filter(kw => {
    // Use word-boundary match to avoid false positives (e.g. "restarted" matching "restart")
    return new RegExp(`\\b${kw}\\b`, "i").test(lower);
  });

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
  const hints = parseMetricHints(text);
  if (hints.keywords.length === 0) return [];

  const queries = keywordsToQueries(hints.keywords, service);
  if (queries.length === 0) return [];

  const range = "1h";

  try {
    return await queryServiceMetrics(service, range, providers, queries);
  } catch (err) {
    logger.warn({ err, text, service }, "metric-extraction: failed to query Prometheus");
    return [];
  }
}

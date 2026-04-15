import { useMemo, useCallback } from "react";
import { ExternalLink } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MetricsPanel } from "./evidence/MetricsPanel";
import { TimelineEntry, type TimelineEntryData } from "./evidence/TimelineEntry";
import type { TimeSeriesData } from "./MetricChart";
import type { EvidenceAction } from "../../types/evidence.js";
import { buildExploreUrl } from "../lib/grafana-links.js";

interface StructuredLog {
  pattern: string;
  count: string | number;
  firstSeen?: string;
  lastSeen?: string;
  sample?: string;
  sampleLines?: string[];
}

interface StructuredInfra {
  resource: string;
  status: string;
  detail: string;
  timestamp?: string;
}

type Observation = string | StructuredLog | StructuredInfra | Record<string, unknown>;

interface EvidenceSection {
  observations: Observation[];
  summary?: string;
}

interface EvidenceData {
  metrics?: EvidenceSection;
  logs?: EvidenceSection;
  infra?: EvidenceSection;
  [key: string]: EvidenceSection | undefined;
}

export interface EvidenceTimelineProps {
  evidence: EvidenceData;
  timeSeries: TimeSeriesData[];
  service: string;
  timeRange?: { from: string; to: string };
  /** Phase-level Grafana actions keyed by role (metrics, logs, infrastructure) */
  phaseActions?: Record<string, EvidenceAction>;
  /** Provider configs for building chart-level deep links */
  providers?: Array<{ role: string; webUrl: string; datasource?: string }>;
}

function isStructuredLog(obs: Observation): obs is StructuredLog {
  return typeof obs === "object" && obs !== null && "pattern" in obs;
}

function isStructuredInfra(obs: Observation): obs is StructuredInfra {
  return typeof obs === "object" && obs !== null && "resource" in obs;
}

// Parse raw log lines. Handles multiple common formats:
//   1. ISO-8601 with T separator: "2026-03-25T13:13:16.394712758+00:00 stderr F <message>"
//   2. Java/Spring space+comma: "2026-04-15 09:52:12,309 WARN 1 --- [main] <message>"
//   3. Java/Spring space+period: "2026-04-15 09:52:12.309 INFO <message>"
//   4. Bracketed ISO: "[2026-04-15T09:52:12Z] <message>"
const RAW_LOG_RE_ISO = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)?)\s+(?:std(?:err|out)\s+[A-Z]\s+)?(.+)/s;
const RAW_LOG_RE_SPACE = /^(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})(?:[,.](\d{1,9}))?\s+(.+)/s;
const RAW_LOG_RE_BRACKETED = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)?)\]\s*(.+)/s;

function parseRawLogLine(line: string): { timestamp: string; message: string } | null {
  // Try ISO-8601 with T first (most precise)
  let m = line.match(RAW_LOG_RE_ISO);
  if (m) return { timestamp: m[1]!, message: m[2]!.trim() };

  // Try bracketed ISO
  m = line.match(RAW_LOG_RE_BRACKETED);
  if (m) return { timestamp: m[1]!, message: m[2]!.trim() };

  // Try space-separated Java/Spring format. Normalize to ISO-8601 so formatTime()
  // can parse it uniformly. Comma milliseconds (",309") become period (".309").
  m = line.match(RAW_LOG_RE_SPACE);
  if (m) {
    const date = m[1]!;
    const time = m[2]!;
    const ms = m[3] ? `.${m[3].slice(0, 3).padEnd(3, "0")}` : "";
    // Assume UTC since the log line doesn't carry a timezone. formatTime uses
    // getUTCHours so this stays correct regardless of the viewer's locale.
    return { timestamp: `${date}T${time}${ms}Z`, message: m[4]!.trim() };
  }

  return null;
}

// K8s-specific entity extraction: matches pod/deployment/service resource paths.
// Extend with additional patterns for non-K8s environments (ECS, VMs, etc.).
function extractEntity(text: string): string {
  // Try to extract service/pod names from patterns
  // Match pod/service-name patterns
  const podMatch = text.match(/(?:pod\/|deployment\/|service\/)?([\w-]+-[\w]+-[\w]+)/);
  if (podMatch) return podMatch[1];
  // Match hostname:port patterns
  const hostMatch = text.match(/([\w-]+):\d+/);
  if (hostMatch) return hostMatch[1];
  // Match "to <name>" patterns
  const toMatch = text.match(/to\s+([\w][\w.-]+)/i);
  if (toMatch) return toMatch[1];
  return "unknown";
}

function tryParseTimestamp(ts: string | undefined): number {
  if (!ts) return Infinity;
  try {
    const ms = new Date(ts).getTime();
    return isNaN(ms) ? Infinity : ms;
  } catch {
    return Infinity;
  }
}

export function EvidenceTimeline({ evidence, timeSeries, service, timeRange, phaseActions, providers }: EvidenceTimelineProps) {
  const metricsProvider = providers?.find(p => p.role === "metrics");

  // Parse metric observations — objects stay as structured, strings get parsed if they match
  // the pattern "metric_name (instance) = value (baseline value) – severity"
  const METRIC_TEXT_RE = /^(.+?)\s*\(([^)]+)\)\s*=\s*([^\s]+)\s*\(baseline\s+([^)]+)\)\s*[–-]\s*(\w+)$/;

  const { textMetricObs, structuredMetricObs } = useMemo(() => {
    const texts: string[] = [];
    const structured: Array<{ metric: string; currentValue: string; baselineValue: string; severity?: string }> = [];

    for (const obs of evidence.metrics?.observations ?? []) {
      if (typeof obs === "object" && obs !== null && "metric" in obs) {
        structured.push(obs as any);
      } else if (typeof obs === "string") {
        const m = obs.match(METRIC_TEXT_RE);
        if (m) {
          structured.push({ metric: `${m[1]!.trim()} (${m[2]!.trim()})`, currentValue: m[3]!, baselineValue: m[4]!, severity: m[5] });
        } else {
          texts.push(obs);
        }
      }
    }

    return { textMetricObs: texts, structuredMetricObs: structured };
  }, [evidence.metrics]);

  // Count deduplicated timeSeries for the tab label
  const seenQueries = new Set<string>();
  const allSeriesCount = timeSeries.filter(ts => {
    const key = ts.query || ts.metric || "";
    if (seenQueries.has(key)) return false;
    seenQueries.add(key);
    return true;
  }).length;

  const hasMetricData = timeSeries.length > 0 || textMetricObs.length > 0 || structuredMetricObs.length > 0;

  // Build chronological timeline entries from logs + infra.
  // When an observation has no real timestamp, fall back to the investigation
  // window start (timeRange.from) and mark the entry as approximate so the UI
  // can prefix it with "~" to signal "happened somewhere in this window".
  const fallbackTimestamp = timeRange?.from ?? "";

  const timelineEntries = useMemo<TimelineEntryData[]>(() => {
    const entries: TimelineEntryData[] = [];
    let idCounter = 0;

    // Process log observations
    const logObs = evidence.logs?.observations ?? [];
    for (const obs of logObs) {
      if (isStructuredLog(obs)) {
        const hasRealTs = !!(obs.firstSeen || obs.lastSeen);
        entries.push({
          id: `log-${idCounter++}`,
          type: "log",
          timestamp: obs.firstSeen || fallbackTimestamp,
          timestampEnd: obs.lastSeen,
          isApproximate: !hasRealTs && !!fallbackTimestamp,
          entity: extractEntity(obs.pattern),
          summary: obs.pattern,
          count: typeof obs.count === "string" ? parseInt(obs.count, 10) || undefined : obs.count || undefined,
          expandedContent: obs.sampleLines?.join("\n") ?? obs.sample,
        });
      } else if (typeof obs === "string") {
        const parsed = parseRawLogLine(obs);
        const realTs = parsed?.timestamp;
        entries.push({
          id: `log-${idCounter++}`,
          type: "log",
          timestamp: realTs || fallbackTimestamp,
          isApproximate: !realTs && !!fallbackTimestamp,
          entity: extractEntity(parsed?.message ?? obs),
          summary: parsed?.message ?? obs,
        });
      }
    }

    // Process infra observations
    const infraObs = evidence.infra?.observations ?? [];
    for (const obs of infraObs) {
      if (isStructuredInfra(obs)) {
        const hasRealTs = !!obs.timestamp;
        entries.push({
          id: `infra-${idCounter++}`,
          type: "infra",
          timestamp: obs.timestamp || fallbackTimestamp || new Date(0).toISOString(),
          isApproximate: !hasRealTs && !!fallbackTimestamp,
          entity: obs.resource,
          summary: obs.detail,
          severity: obs.status,
        });
      } else if (typeof obs === "string") {
        entries.push({
          id: `infra-${idCounter++}`,
          type: "infra",
          timestamp: fallbackTimestamp,
          isApproximate: !!fallbackTimestamp,
          entity: service || "unknown",
          summary: obs,
        });
      }
    }

    // Sort chronologically by timestamp ascending, Infinity entries go to end
    entries.sort((a, b) => tryParseTimestamp(a.timestamp) - tryParseTimestamp(b.timestamp));

    // Deduplicate log entries: exact match on normalized summary, then
    // substring containment to group short/long forms of the same event.
    // Normalization is generic (timestamps, log levels, quotes) — no
    // framework-specific patterns.

    function normalizeForDedup(summary: string): string {
      let s = summary.trim();
      // Strip leading timestamps: ISO-8601, bracketed dates, syslog-style
      s = s.replace(/^\[?\d{4}-\d{2}-\d{2}[\sT][\d:.Z+-]+\]?\s*/i, "").trim();
      // Strip leading log levels (with optional colon/bracket delimiters)
      s = s.replace(/^(?:ERROR|WARNING|WARN|INFO|DEBUG|CRITICAL|FATAL|TRACE)[\s:\]]+/i, "").trim();
      // Strip bracketed metadata: [None] [module:line] [pid] etc.
      s = s.replace(/^\[(?:[^\]]*)\]\s*/g, "").trim();
      // Strip leading/trailing quotes
      s = s.replace(/^"(.+)"$/, "$1").trim();
      return s.toLowerCase();
    }

    const deduped: TimelineEntryData[] = [];
    const seen = new Map<string, number>(); // normalized summary → index in deduped

    function mergeInto(existing: TimelineEntryData, entry: TimelineEntryData) {
      existing.count = (existing.count ?? 1) + (entry.count ?? 1);
      if (entry.timestamp && tryParseTimestamp(entry.timestamp) < tryParseTimestamp(existing.timestamp)) {
        existing.timestamp = entry.timestamp;
      }
      if (entry.timestamp) {
        const entryTs = entry.timestampEnd ?? entry.timestamp;
        const existingEnd = existing.timestampEnd ?? existing.timestamp;
        if (tryParseTimestamp(entryTs) > tryParseTimestamp(existingEnd)) {
          existing.timestampEnd = entryTs;
        }
      }
    }

    for (const entry of entries) {
      if (entry.type !== "log") {
        deduped.push(entry);
        continue;
      }
      const key = normalizeForDedup(entry.summary);

      // Skip dedup for empty/trivial summaries — don't merge unrelated malformed entries
      if (key.length < 3) {
        deduped.push({ ...entry });
        continue;
      }

      // Pass 1: exact match
      const existingIdx = seen.get(key);
      if (existingIdx !== undefined) {
        mergeInto(deduped[existingIdx]!, entry);
        continue;
      }

      // Pass 2: substring containment — if this entry's core message is
      // contained in an existing entry (or vice versa), they're the same event.
      // Only match if the shorter string is ≥60% of the longer to avoid
      // false positives like "error" matching "error in auth module".
      let merged = false;
      if (key.length >= 10) {
        for (const [existingKey, idx] of seen) {
          if (existingKey.length < 10) continue;
          if (existingKey.includes(key) || key.includes(existingKey)) {
            const shorter = Math.min(key.length, existingKey.length);
            const longer = Math.max(key.length, existingKey.length);
            if (shorter / longer >= 0.6) {
              mergeInto(deduped[idx]!, entry);
              merged = true;
              break;
            }
          }
        }
      }

      if (!merged) {
        seen.set(key, deduped.length);
        deduped.push({ ...entry });
      }
    }

    return deduped;
  }, [evidence.logs, evidence.infra, service]);

  const hasTimeline = timelineEntries.length > 0;

  if (!hasMetricData && !hasTimeline) {
    return null;
  }

  const metricsCount = allSeriesCount + structuredMetricObs.length + textMetricObs.length;
  const defaultTab = hasMetricData ? "metrics" : "timeline";

  return (
    <Tabs defaultValue={defaultTab} className="w-full">
      <TabsList className="w-full bg-secondary/20 border border-border/25 rounded-lg p-0.5">
        {hasMetricData && (
          <TabsTrigger value="metrics" className="flex-1 text-[10px] font-mono uppercase tracking-[0.12em]">
            Metrics ({metricsCount})
          </TabsTrigger>
        )}
        {hasTimeline && (
          <TabsTrigger value="timeline" className="flex-1 text-[10px] font-mono uppercase tracking-[0.12em]">
            Timeline ({timelineEntries.length})
          </TabsTrigger>
        )}
      </TabsList>

      {hasMetricData && (
        <TabsContent value="metrics" className="mt-3">
          <MetricsPanel
            timeSeries={timeSeries}
            textObservations={textMetricObs}
            structuredObservations={structuredMetricObs as any}
            service={service}
            timeRange={timeRange}
            buildChartUrl={metricsProvider ? (query: string) => buildExploreUrl({
              webUrl: metricsProvider.webUrl,
              datasource: metricsProvider.datasource,
              query,
              from: timeRange?.from ?? "",
              to: timeRange?.to ?? "",
            }) : undefined}
          />
        </TabsContent>
      )}

      {hasTimeline && (
        <TabsContent value="timeline" className="mt-3">
          {/* Phase headers with Grafana links */}
          {(() => {
            const infraEntries = timelineEntries.filter(e => e.type === "infra");
            const logEntries = timelineEntries.filter(e => e.type === "log");
            const infraAction = phaseActions?.["infrastructure"] ?? phaseActions?.["infra"];
            const logsAction = phaseActions?.["logs"];

            // Inject phase actions into entries
            const enrichedInfra = infraEntries.map(e => ({ ...e, phaseAction: infraAction }));
            const enrichedLogs = logEntries.map(e => ({ ...e, phaseAction: logsAction }));

            return (
              <>
                {enrichedInfra.length > 0 && (
                  <div className="mb-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
                        Infrastructure ({enrichedInfra.length})
                      </span>
                      {infraAction && (
                        <a
                          href={infraAction.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-[9px] text-muted-foreground/40 hover:text-primary transition-colors"
                        >
                          Open in Grafana <ExternalLink size={9} />
                        </a>
                      )}
                    </div>
                    <div role="list" className="relative border-l border-border/30 ml-1 pl-1">
                      {enrichedInfra.map(entry => <TimelineEntry key={entry.id} entry={entry} />)}
                    </div>
                  </div>
                )}
                {enrichedLogs.length > 0 && (
                  <div className="mb-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
                        Logs ({enrichedLogs.length})
                      </span>
                      {logsAction && (
                        <a
                          href={logsAction.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-[9px] text-muted-foreground/40 hover:text-primary transition-colors"
                        >
                          Open in Grafana <ExternalLink size={9} />
                        </a>
                      )}
                    </div>
                    <div role="list" className="relative border-l border-border/30 ml-1 pl-1">
                      {enrichedLogs.map(entry => <TimelineEntry key={entry.id} entry={entry} />)}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </TabsContent>
      )}
    </Tabs>
  );
}

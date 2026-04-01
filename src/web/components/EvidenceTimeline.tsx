import { useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MetricsPanel } from "./evidence/MetricsPanel";
import { TimelineEntry, type TimelineEntryData } from "./evidence/TimelineEntry";
import type { TimeSeriesData } from "./MetricChart";

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
}

function isStructuredLog(obs: Observation): obs is StructuredLog {
  return typeof obs === "object" && obs !== null && "pattern" in obs;
}

function isStructuredInfra(obs: Observation): obs is StructuredInfra {
  return typeof obs === "object" && obs !== null && "resource" in obs;
}

// Parse raw log lines: "2026-03-25T13:13:16.394712758+00:00 stderr F <message>"
const RAW_LOG_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)?)\s+(?:std(?:err|out)\s+[A-Z]\s+)?(.+)/s;

function parseRawLogLine(line: string): { timestamp: string; message: string } | null {
  const m = line.match(RAW_LOG_RE);
  if (!m) return null;
  return { timestamp: m[1]!, message: m[2]!.trim() };
}

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

export function EvidenceTimeline({ evidence, timeSeries, service, timeRange }: EvidenceTimelineProps) {
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

  // Build chronological timeline entries from logs + infra
  const timelineEntries = useMemo<TimelineEntryData[]>(() => {
    const entries: TimelineEntryData[] = [];
    let idCounter = 0;

    // Process log observations
    const logObs = evidence.logs?.observations ?? [];
    for (const obs of logObs) {
      if (isStructuredLog(obs)) {
        entries.push({
          id: `log-${idCounter++}`,
          type: "log",
          timestamp: obs.firstSeen ?? "",
          timestampEnd: obs.lastSeen,
          entity: extractEntity(obs.pattern),
          summary: obs.pattern,
          count: typeof obs.count === "string" ? parseInt(obs.count, 10) || undefined : obs.count || undefined,
          expandedContent: obs.sampleLines?.join("\n") ?? obs.sample,
        });
      } else if (typeof obs === "string") {
        const parsed = parseRawLogLine(obs);
        entries.push({
          id: `log-${idCounter++}`,
          type: "log",
          timestamp: parsed?.timestamp ?? "",
          entity: extractEntity(parsed?.message ?? obs),
          summary: parsed?.message ?? obs,
        });
      }
    }

    // Process infra observations
    const infraObs = evidence.infra?.observations ?? [];
    for (const obs of infraObs) {
      if (isStructuredInfra(obs)) {
        entries.push({
          id: `infra-${idCounter++}`,
          type: "infra",
          timestamp: obs.timestamp ?? new Date(0).toISOString(),
          entity: obs.resource,
          summary: obs.detail,
          severity: obs.status,
        });
      } else if (typeof obs === "string") {
        entries.push({
          id: `infra-${idCounter++}`,
          type: "infra",
          timestamp: "",
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
      existing.count = (existing.count ?? 1) + 1;
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
          <TabsTrigger value="metrics" className="flex-1 text-[10px] font-mono uppercase tracking-wider">
            Metrics ({metricsCount})
          </TabsTrigger>
        )}
        {hasTimeline && (
          <TabsTrigger value="timeline" className="flex-1 text-[10px] font-mono uppercase tracking-wider">
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
          />
        </TabsContent>
      )}

      {hasTimeline && (
        <TabsContent value="timeline" className="mt-3">
          <div
            role="list"
            className="relative border-l border-border/30 ml-1 pl-1"
          >
            {timelineEntries.map((entry) => (
              <TimelineEntry key={entry.id} entry={entry} />
            ))}
          </div>
        </TabsContent>
      )}
    </Tabs>
  );
}

import { useMemo } from "react";
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
  // Collect string observations from metrics for smart extraction
  const textMetricObs = useMemo<string[]>(() => {
    if (!evidence.metrics?.observations) return [];
    return evidence.metrics.observations.filter((obs): obs is string => typeof obs === "string");
  }, [evidence.metrics]);

  // Also check for structured metric observations (objects with metric/currentValue)
  const structuredMetricObs = useMemo(() => {
    if (!evidence.metrics?.observations) return [];
    return evidence.metrics.observations.filter((obs): obs is Record<string, unknown> =>
      typeof obs === "object" && obs !== null && "metric" in obs
    );
  }, [evidence.metrics]);

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
        entries.push({
          id: `log-${idCounter++}`,
          type: "log",
          timestamp: "",
          entity: service || "unknown",
          summary: obs,
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

    return entries;
  }, [evidence.logs, evidence.infra, service]);

  const hasTimeline = timelineEntries.length > 0;

  if (!hasMetricData && !hasTimeline) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Metrics Panel */}
      {hasMetricData && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-0.5 h-4 bg-primary rounded-full" />
            <h4 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
              Metrics
            </h4>
          </div>
          <MetricsPanel
            timeSeries={timeSeries}
            textObservations={textMetricObs}
            structuredObservations={structuredMetricObs as any}
            service={service}
            timeRange={timeRange}
          />
        </div>
      )}

      {/* Timeline */}
      {hasTimeline && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-0.5 h-4 bg-primary rounded-full" />
            <h4 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
              Timeline
            </h4>
            <span className="font-mono text-[9px] text-muted-foreground/40">
              {timelineEntries.length}
            </span>
          </div>
          <div
            role="list"
            className="relative border-l border-border/30 ml-1 pl-1"
          >
            {timelineEntries.map((entry) => (
              <TimelineEntry key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

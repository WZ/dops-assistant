import { useEffect, useState, useRef, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PhaseStepper, type PhaseState } from "./PhaseStepper";
import { EvidenceCards } from "./EvidenceCards";
import { RcaReport } from "./RcaReport";
import type { TimelineEvent } from "./ActivityTimeline";
import type { TimeSeriesData } from "./MetricChart";
import type { ServerMessage } from "../../shared/ws-types.js";

const DEFAULT_PHASES: PhaseState[] = [
  { name: "planning", label: "Planning", status: "pending" },
  { name: "metrics", label: "Metrics", status: "pending" },
  { name: "logs", label: "Logs", status: "pending" },
  { name: "infra", label: "Infrastructure", status: "pending" },
  { name: "synthesis", label: "Synthesis", status: "pending" },
];

export function InvestigationPane({ investigationId, wsMessages, onBack }: { investigationId: string; wsMessages: ServerMessage[]; onBack: () => void }) {
  const [phases, setPhases] = useState<PhaseState[]>(DEFAULT_PHASES);
  const [evidence, setEvidence] = useState<Record<string, unknown>>({});
  const [report, setReport] = useState<unknown | null>(null);
  const [service, setService] = useState("");
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const processedCount = useRef(0);

  // Determine if this investigation is active (has WS messages) or historical
  const isActive = wsMessages.some(
    (m) => (m.type === "investigation:started" && m.id === investigationId) ||
           (m.type === "investigation:complete" && m.id === investigationId),
  );

  // Fetch historical investigation data from REST API when not active
  useEffect(() => {
    if (isActive) return;

    let cancelled = false;
    fetch(`/api/investigations/${investigationId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: {
        investigation: { service: string; status: string; report: string | null };
        phases: Array<{ phase: string; status: string; findings: string | null }>;
        events?: Array<{ event_type: string; payload: string; created_at: string }>;
      }) => {
        if (cancelled) return;
        setService(data.investigation.service);

        const phaseMap = new Map(data.phases.map((p) => [p.phase, p]));
        setPhases(DEFAULT_PHASES.map((dp) => {
          const stored = phaseMap.get(dp.name);
          if (stored) {
            return { ...dp, status: stored.status as PhaseState["status"] };
          }
          if (data.investigation.status === "complete") {
            return { ...dp, status: "complete" as const };
          }
          return dp;
        }));

        const evidenceData: Record<string, unknown> = {};
        for (const p of data.phases) {
          if (p.findings) {
            try { evidenceData[p.phase] = JSON.parse(p.findings); } catch { /* ignore */ }
          }
        }
        if (data.investigation.report) {
          try {
            const rpt = JSON.parse(data.investigation.report);
            if (rpt.evidence) {
              if (rpt.evidence.metrics?.length && !evidenceData["metrics"]) {
                evidenceData["metrics"] = { observations: rpt.evidence.metrics };
              }
              if (rpt.evidence.logs?.length && !evidenceData["logs"]) {
                evidenceData["logs"] = { observations: rpt.evidence.logs };
              }
              if (rpt.evidence.infra?.length && !evidenceData["infra"]) {
                evidenceData["infra"] = { observations: rpt.evidence.infra };
              }
            }
          } catch { /* ignore */ }
        }
        if (Object.keys(evidenceData).length > 0) {
          setEvidence(evidenceData);
        }

        if (data.investigation.report) {
          try { setReport(JSON.parse(data.investigation.report)); } catch { /* ignore */ }
        }

        // Restore persisted timeline events
        if (data.events && data.events.length > 0) {
          const restored: TimelineEvent[] = [];
          for (const row of data.events) {
            try {
              const payload = JSON.parse(row.payload);
              const ts = new Date(row.created_at).getTime();
              if (payload.type === "investigation:tool_call") {
                restored.push({ type: "tool_call", phase: payload.phase, tool: payload.tool, args: payload.args ?? {}, status: payload.status, result: payload.result, durationMs: payload.durationMs, timestamp: ts });
              } else if (payload.type === "investigation:iteration") {
                restored.push({ type: "iteration", phase: payload.phase, iteration: payload.iteration, maxIterations: payload.maxIterations, description: payload.description, timestamp: ts });
              } else if (payload.type === "investigation:phase") {
                restored.push({ type: "phase_change", phase: payload.phase, status: payload.status, stats: payload.stats ? { toolCalls: payload.stats.toolCalls, iterations: payload.stats.iterations, durationMs: payload.stats.durationMs } : undefined, timestamp: ts });
              }
            } catch { /* ignore */ }
          }
          if (restored.length > 0) setTimelineEvents(restored);
        }
      })
      .catch(() => { /* silently fail */ });

    return () => { cancelled = true; };
  }, [investigationId, isActive]);

  // Process live WebSocket messages
  useEffect(() => {
    const newMessages = wsMessages.slice(processedCount.current);
    processedCount.current = wsMessages.length;

    for (const msg of newMessages) {
      if (msg.type === "investigation:started" && msg.id === investigationId) {
        setService(msg.service);
        setPhases([...DEFAULT_PHASES]);
        setEvidence({});
        setReport(null);
        setTimelineEvents([]);
      }
      if (msg.type === "investigation:phase") {
        setPhases((prev) => prev.map((p) =>
          p.name === msg.phase ? { ...p, status: msg.status as PhaseState["status"], substatus: undefined, stats: msg.stats } : p,
        ));
        if (msg.status === "complete" && msg.data) {
          setEvidence((prev) => ({ ...prev, [msg.phase]: msg.data }));
        }
        setTimelineEvents((prev) => [...prev, {
          type: "phase_change" as const,
          phase: msg.phase,
          status: msg.status as "running" | "complete" | "failed",
          stats: msg.stats ? { toolCalls: msg.stats.toolCalls, iterations: msg.stats.iterations, durationMs: msg.stats.durationMs } : undefined,
          timestamp: Date.now(),
        }]);
      }
      if (msg.type === "investigation:tool_call") {
        setTimelineEvents((prev) => [...prev, {
          type: "tool_call",
          phase: msg.phase,
          tool: msg.tool,
          args: msg.args,
          status: msg.status,
          result: msg.result,
          durationMs: msg.durationMs,
          timestamp: Date.now(),
        }]);
      }
      if (msg.type === "investigation:iteration") {
        setTimelineEvents((prev) => [...prev, {
          type: "iteration",
          phase: msg.phase,
          iteration: msg.iteration,
          maxIterations: msg.maxIterations,
          description: msg.description,
          timestamp: Date.now(),
        }]);
      }
      if (msg.type === "investigation:progress") {
        setPhases((prev) => prev.map((p) =>
          p.name === msg.phase ? { ...p, substatus: msg.step } : p,
        ));
      }
      if (msg.type === "investigation:complete" && msg.id === investigationId) {
        setReport(msg.report);
        const rpt = msg.report as Record<string, unknown> | null;
        if (rpt?.evidence) {
          const ev = rpt.evidence as Record<string, unknown>;
          setEvidence((prev) => {
            const updated = { ...prev };
            if (Array.isArray(ev.metrics) && ev.metrics.length > 0 && !updated["metrics"]) {
              updated["metrics"] = { observations: ev.metrics };
            }
            if (Array.isArray(ev.logs) && ev.logs.length > 0 && !updated["logs"]) {
              updated["logs"] = { observations: ev.logs };
            }
            if (Array.isArray(ev.infra) && ev.infra.length > 0 && !updated["infra"]) {
              updated["infra"] = { observations: ev.infra };
            }
            return updated;
          });
        }
      }
    }
  }, [wsMessages, investigationId]);

  const isRunning = phases.some((p) => p.status === "running");
  const isComplete = !!report;

  // Extract time-series data from query_prometheus tool call results
  const timeSeries = useMemo<TimeSeriesData[]>(() => {
    const series: TimeSeriesData[] = [];
    for (const evt of timelineEvents) {
      if (evt.type !== "tool_call" || evt.tool !== "query_prometheus" || evt.status !== "success" || !evt.result) continue;
      try {
        const parsed = JSON.parse(evt.result);
        const items = parsed?.data ?? parsed;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          if (item.values && Array.isArray(item.values) && item.values.length >= 2) {
            series.push({
              metric: item.m ?? "unknown",
              instance: item.instance,
              values: item.values.map(([ts, v]: [string, string | number]) => [ts, typeof v === "string" ? parseFloat(v) : v]),
              min: item.min != null ? parseFloat(item.min) : undefined,
              max: item.max != null ? parseFloat(item.max) : undefined,
              avg: item.avg != null ? parseFloat(item.avg) : undefined,
            });
          }
        }
      } catch { /* ignore unparseable results */ }
    }
    return series;
  }, [timelineEvents]);

  const hasEvidence = Object.keys(evidence).length > 0 || timeSeries.length > 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border/40 flex items-center justify-between shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground/60 hover:text-primary transition-colors group"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="group-hover:-translate-x-0.5 transition-transform">
            <path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>
          </svg>
          back
        </button>
        <div className="flex items-center gap-3">
          {service && (
            <>
              <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-primary animate-status-pulse" : "bg-success"}`} />
              <span className="text-sm font-mono font-medium text-foreground/70">{service}</span>
            </>
          )}
          {isRunning && (
            <span className="text-[10px] font-mono text-primary/60 uppercase tracking-wider">investigating...</span>
          )}
        </div>
      </div>

      {/* Progress bar — visible while running */}
      {isRunning && (
        <div className="progress-bar-track shrink-0">
          <div className="progress-bar-fill" />
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-5 py-6 space-y-6">

          {/* Phase progress with merged activity */}
          <section>
            <PhaseStepper phases={phases} events={timelineEvents} evidence={evidence} isComplete={isComplete} />
          </section>

          {/* Report */}
          {report ? (
            <section className="animate-fade-up">
              <RcaReport report={report as any} />
            </section>
          ) : !isRunning ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-48 rounded-md" />
              <Skeleton className="h-32 w-full rounded-lg" />
            </div>
          ) : null}

          {/* Evidence */}
          {hasEvidence && (
            <section>
              <h3 className="text-[9px] font-display font-semibold uppercase tracking-[0.15em] text-muted-foreground/50 mb-3">
                Evidence
              </h3>
              <EvidenceCards evidence={{ ...evidence, timeSeries } as any} />
            </section>
          )}

        </div>
      </div>
    </div>
  );
}

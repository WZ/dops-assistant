import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowLeft, FilePlus, RotateCw, ChevronDown } from "lucide-react";
import { PhaseStepper, type PhaseState } from "./PhaseStepper";
import { EvidenceTimeline } from "./EvidenceTimeline";
import { RcaReport } from "./RcaReport";
import { useStackContext } from "../contexts/StackContext";
import type { TimelineEvent } from "./ActivityTimeline";
import type { TimeSeriesData } from "./MetricChart";
import type { ServerMessage } from "../../types/ws-types.js";
import { formatTokens } from "../lib/formatTokens.js";

const DEFAULT_PHASES: PhaseState[] = [
  { name: "planning", label: "Planning", status: "pending" },
  { name: "metrics", label: "Metrics", status: "pending" },
  { name: "logs", label: "Logs", status: "pending" },
  { name: "infra", label: "Infrastructure", status: "pending" },
  { name: "synthesis", label: "Synthesis", status: "pending" },
];

export function InvestigationPane({ investigationId, wsMessages, onBack, onNavigateSkills, onRerun }: { investigationId: string; wsMessages: ServerMessage[]; onBack: () => void; onNavigateSkills?: () => void; onRerun?: (investigationId: string, template?: string) => void }) {
  const { stackFetch } = useStackContext();
  const [phases, setPhases] = useState<PhaseState[]>(DEFAULT_PHASES);
  const [evidence, setEvidence] = useState<Record<string, unknown>>({});
  const [report, setReport] = useState<unknown | null>(null);
  const [service, setService] = useState("");
  const [query, setQuery] = useState("");
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [phaseTokens, setPhaseTokens] = useState<Record<string, { inputTokens: number; outputTokens: number }>>({});
  const [totalUsage, setTotalUsage] = useState<{ inputTokens: number; outputTokens: number; durationMs: number } | null>(null);
  const processedCount = useRef(0);
  const reportRef = useRef<HTMLDivElement>(null);

  // Scroll RCA report into center view when it appears
  useEffect(() => {
    if (report && reportRef.current) {
      reportRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [report]);

  // Determine if this investigation is active (has WS messages) or historical
  const isActive = wsMessages.some(
    (m) => (m.type === "investigation:started" && m.id === investigationId) ||
           (m.type === "investigation:complete" && m.id === investigationId),
  );

  // Fetch query from REST when not available from WS (e.g. server predates query field)
  useEffect(() => {
    if (query) return;
    let cancelled = false;
    stackFetch(`/api/investigations/${investigationId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: { investigation?: { query?: string } } | null) => {
        if (!cancelled && data?.investigation?.query) setQuery(data.investigation.query);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [investigationId, query]);

  // Fetch historical investigation data from REST API when not active
  useEffect(() => {
    if (isActive) return;

    let cancelled = false;
    stackFetch(`/api/investigations/${investigationId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: {
        investigation: { service: string; query: string; status: string; report: string | null; total_input_tokens?: number; total_output_tokens?: number; total_duration_ms?: number };
        phases: Array<{ phase: string; status: string; findings: string | null }>;
        events?: Array<{ event_type: string; payload: string; created_at: string }>;
      }) => {
        if (cancelled) return;
        setService(data.investigation.service);
        if (data.investigation.query) setQuery(data.investigation.query);

        if (data.investigation.total_input_tokens && data.investigation.total_input_tokens > 0) {
          setTotalUsage({
            inputTokens: data.investigation.total_input_tokens,
            outputTokens: data.investigation.total_output_tokens ?? 0,
            durationMs: data.investigation.total_duration_ms ?? 0,
          });
        }

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
        setQuery(msg.query);
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
      if (msg.type === "investigation:phase_usage" && msg.investigationId === investigationId) {
        setPhaseTokens((prev) => ({
          ...prev,
          [msg.phase]: { inputTokens: msg.inputTokens, outputTokens: msg.outputTokens },
        }));
      }
      if (msg.type === "investigation:total_usage" && msg.investigationId === investigationId) {
        setTotalUsage({ inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, durationMs: msg.durationMs });
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
        // Try common parameter names for the PromQL expression
        const a = evt.args ?? {};
        const query = typeof a.query === "string" ? a.query
          : typeof a.expr === "string" ? a.expr
          : typeof a.expression === "string" ? a.expression
          : undefined;
        for (const item of items) {
          if (item.values && Array.isArray(item.values) && item.values.length >= 2) {
            series.push({
              metric: item.m || "",
              instance: item.instance,
              query,
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
        <Button
          variant="ghost"
          onClick={onBack}
          className="h-auto px-0 py-0 text-xs font-mono text-muted-foreground/60 hover:text-primary hover:bg-transparent transition-colors group"
        >
          <ArrowLeft size={12} className="!size-auto group-hover:-translate-x-0.5 transition-transform" />
          back
        </Button>
        <div className="flex items-center gap-3">
          {service && (
            <>
              <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-primary animate-status-pulse" : "bg-success"}`} />
              <span className="text-sm font-mono font-medium text-foreground/70">{service}</span>
            </>
          )}
          {isRunning && (
            <span className="text-[10px] font-mono text-primary/60 uppercase tracking-[0.12em]">investigating...</span>
          )}
          {isComplete && onRerun && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  disabled={isRunning}
                  className="h-auto px-2.5 py-1 text-[10px] font-mono border-primary/30 text-primary/70 hover:bg-primary/8 hover:text-primary gap-1"
                >
                  <RotateCw size={10} className="!size-auto" />
                  Re-investigate
                  <ChevronDown size={8} className="!size-auto opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuItem onClick={() => onRerun(investigationId)} className="font-mono text-[11px]">
                  Re-run (current config)
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onRerun(investigationId, "quick")} className="font-mono text-[11px] text-muted-foreground">
                  Quick (metrics only)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRerun(investigationId, "standard")} className="font-mono text-[11px] text-muted-foreground">
                  Standard (metrics + logs)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRerun(investigationId, "full")} className="font-mono text-[11px] text-muted-foreground">
                  Full (all phases)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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

          {/* Original query */}
          {query && (
            <p className="text-sm font-mono text-foreground/70 italic">&ldquo;{query}&rdquo;</p>
          )}

          {/* Phase progress with merged activity */}
          <section>
            <PhaseStepper phases={phases} events={timelineEvents} evidence={evidence} isComplete={isComplete} phaseTokens={phaseTokens} />
          </section>

          {/* Report */}
          {report ? (
            <section ref={reportRef} className="animate-fade-up">
              <RcaReport report={report as any} />
              {/* Save as Skill */}
              <div className="mt-3 flex justify-end">
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      const rpt = report as Record<string, unknown>;
                      const res = await stackFetch("/api/skills/generate", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(rpt),
                      });
                      if (!res.ok) return;
                      const generated = await res.json();
                      await stackFetch("/api/skills", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(generated),
                      });
                      onNavigateSkills?.();
                    } catch { /* ignore */ }
                  }}
                  className="px-3 py-1.5 h-auto text-[10px] font-mono border-primary/20 text-primary/70 hover:bg-primary/8 hover:text-primary"
                >
                  <FilePlus size={10} className="!size-auto" />
                  Save as Skill
                </Button>
              </div>
            </section>
          ) : !isRunning ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-48 rounded-md" />
              <Skeleton className="h-32 w-full rounded-lg" />
            </div>
          ) : null}

          {totalUsage && (
            <div className="flex items-center gap-2 px-4 py-2 text-[10px] font-mono text-muted-foreground/50 border-t border-border/20">
              <span>Total:</span>
              <span>{formatTokens(totalUsage.inputTokens)} input</span>
              <span>·</span>
              <span>{formatTokens(totalUsage.outputTokens)} output</span>
              <span>·</span>
              <span>{formatTokens(totalUsage.inputTokens + totalUsage.outputTokens)} tokens</span>
              <span>·</span>
              <span>{(totalUsage.durationMs / 1000).toFixed(1)}s</span>
            </div>
          )}

          {/* Evidence */}
          {hasEvidence && (
            <section>
              <EvidenceTimeline
                evidence={evidence as any}
                timeSeries={timeSeries}
                service={service}
              />
            </section>
          )}

        </div>
      </div>
    </div>
  );
}

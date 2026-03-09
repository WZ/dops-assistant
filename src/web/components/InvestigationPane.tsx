import { useEffect, useState, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PhaseStepper, type PhaseState } from "./PhaseStepper";
import { EvidenceCards } from "./EvidenceCards";
import { RcaReport } from "./RcaReport";
import { InvestigationLayout } from "./InvestigationLayout";
import { ActivityTimeline, type TimelineEvent } from "./ActivityTimeline";
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
      .then((data: { investigation: { service: string; status: string; report: string | null }; phases: Array<{ phase: string; status: string; findings: string | null }> }) => {
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
      }
    }
  }, [wsMessages, investigationId]);

  const isRunning = phases.some((p) => p.status === "running");

  return (
    <div className={`h-full flex flex-col relative z-[2] ${isRunning ? "scanlines" : ""}`}>
      {/* Header bar */}
      <div className="px-4 py-2.5 border-b border-border/40 flex items-center justify-between shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground/40 hover:text-primary/70 transition-colors group"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="group-hover:-translate-x-0.5 transition-transform">
            <path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>
          </svg>
          back
        </button>
        <div className="flex items-center gap-2">
          {service && (
            <>
              <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-primary animate-status-pulse" : "bg-success"}`} />
              <span className="text-xs font-mono text-muted-foreground/50">{service}</span>
            </>
          )}
        </div>
      </div>

      {/* Three-panel layout */}
      <div className="flex-1 min-h-0">
        <InvestigationLayout
          leftPanel={
            <div className="p-4">
              <h2 className="font-display text-sm font-bold tracking-tight text-foreground/90 mb-4">
                Phases
              </h2>
              <PhaseStepper phases={phases} />
            </div>
          }
          centerPanel={
            <div className="h-full flex flex-col">
              {report ? (
                <Tabs defaultValue="report" className="h-full flex flex-col">
                  <TabsList className="mx-4 mt-3 bg-secondary/30 border border-border/30 rounded-lg p-0.5 shrink-0">
                    <TabsTrigger value="report" className="flex-1 text-[11px] font-mono">Report</TabsTrigger>
                    <TabsTrigger value="deepdive" className="flex-1 text-[11px] font-mono">Deep Dive</TabsTrigger>
                  </TabsList>
                  <TabsContent value="report" className="flex-1 overflow-y-auto p-4 mt-0">
                    <RcaReport report={report as any} />
                  </TabsContent>
                  <TabsContent value="deepdive" className="flex-1 overflow-y-auto p-4 mt-0">
                    <div className="text-xs text-muted-foreground/40 text-center py-8 font-mono">Deep Investigation coming soon</div>
                  </TabsContent>
                </Tabs>
              ) : (
                <ActivityTimeline events={timelineEvents} />
              )}
            </div>
          }
          rightPanel={
            <Tabs defaultValue="evidence" className="h-full flex flex-col">
              <TabsList className="mx-4 mt-3 bg-secondary/30 border border-border/30 rounded-lg p-0.5 shrink-0">
                <TabsTrigger value="evidence" className="flex-1 text-[11px] font-mono">Evidence</TabsTrigger>
                <TabsTrigger value="dependencies" className="flex-1 text-[11px] font-mono">Dependencies</TabsTrigger>
              </TabsList>
              <TabsContent value="evidence" className="flex-1 overflow-y-auto p-4 mt-0">
                {Object.keys(evidence).length === 0 ? (
                  <div className="space-y-2.5">
                    <Skeleton className="h-16 w-full rounded-lg" />
                    <Skeleton className="h-16 w-full rounded-lg" />
                  </div>
                ) : (
                  <EvidenceCards evidence={evidence as any} />
                )}
              </TabsContent>
              <TabsContent value="dependencies" className="flex-1 overflow-y-auto p-4 mt-0">
                <div className="text-xs text-muted-foreground/40 text-center py-8 font-mono">Dependency graph coming soon</div>
              </TabsContent>
            </Tabs>
          }
        />
      </div>
    </div>
  );
}

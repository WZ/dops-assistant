import { useEffect, useState, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PhaseStepper, type PhaseState } from "./PhaseStepper";
import { EvidenceCards } from "./EvidenceCards";
import { RcaReport } from "./RcaReport";
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
      }
      if (msg.type === "investigation:phase") {
        setPhases((prev) => prev.map((p) =>
          p.name === msg.phase ? { ...p, status: msg.status as PhaseState["status"], substatus: undefined } : p,
        ));
        if (msg.status === "complete" && msg.data) {
          setEvidence((prev) => ({ ...prev, [msg.phase]: msg.data }));
        }
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
    <div className={`h-full overflow-y-auto p-6 relative z-[2] ${isRunning ? "scanlines" : ""}`}>
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground/40 hover:text-primary/70 transition-colors mb-5 group"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="group-hover:-translate-x-0.5 transition-transform">
          <path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>
        </svg>
        back to dashboard
      </button>

      {/* Title */}
      <div className="mb-6 animate-fade-up">
        <h2 className="font-display text-lg font-bold tracking-tight text-foreground/90">
          Investigation
        </h2>
        {service && (
          <div className="flex items-center gap-2 mt-1">
            <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-primary animate-status-pulse" : "bg-success"}`} />
            <span className="text-xs font-mono text-muted-foreground/50">{service}</span>
          </div>
        )}
      </div>

      {/* Phase Stepper */}
      <div className="mb-8">
        <PhaseStepper phases={phases} />
      </div>

      {/* Evidence */}
      <div className="mb-8 animate-fade-up delay-3">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-1 h-4 rounded-full bg-accent/50" />
          <h3 className="text-[11px] font-display font-semibold text-muted-foreground/50 uppercase tracking-[0.15em]">
            Evidence
          </h3>
        </div>
        {Object.keys(evidence).length === 0 ? (
          <div className="space-y-2.5">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : (
          <EvidenceCards evidence={evidence as any} />
        )}
      </div>

      {/* RCA Report */}
      {report ? (
        <div className="animate-fade-up delay-5">
          <RcaReport report={report as any} />
        </div>
      ) : (
        isRunning && (
          <div className="space-y-2.5 animate-fade-in">
            <Skeleton className="h-6 w-40 rounded-md" />
            <Skeleton className="h-28 w-full rounded-lg" />
          </div>
        )
      )}
    </div>
  );
}

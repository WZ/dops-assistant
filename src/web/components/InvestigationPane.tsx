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

  return (
    <div className="h-full overflow-y-auto p-6">
      <button onClick={onBack} className="text-sm text-muted-foreground hover:underline mb-4">&larr; Back to dashboard</button>
      <h2 className="text-xl font-bold mb-1">Investigation</h2>
      {service && <p className="text-sm text-muted-foreground mb-6">{service}</p>}

      <div className="mb-6">
        <PhaseStepper phases={phases} />
      </div>

      <div className="mb-6">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Evidence</h3>
        {Object.keys(evidence).length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <EvidenceCards evidence={evidence as any} />
        )}
      </div>

      {report ? (
        <RcaReport report={report as any} />
      ) : (
        phases.some((p) => p.status === "running") && (
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-32 w-full" />
          </div>
        )
      )}
    </div>
  );
}

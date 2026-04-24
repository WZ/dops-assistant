/**
 * ScanRunPhaseStepper — stateless left-sidebar stepper for the scan-run
 * detail page. Renders the three scan phases (Probe -> Triage -> Investigate)
 * with the same compact-phase-rail styling used by `InvestigationPane`
 * (`CompactPhaseRail`), so the two detail views read as one family.
 */

export type ScanPhase = "probe" | "triage" | "investigate";

export type ScanPhaseStatus = "pending" | "running" | "complete" | "failed";

export interface ScanPhaseState {
  phase: ScanPhase;
  status: ScanPhaseStatus;
  summary?: string;
}

export function ScanRunPhaseStepper({ states }: { states: ScanPhaseState[] }) {
  return (
    <ul className="space-y-0">
      {states.map((s) => (
        <li key={s.phase} className="flex items-center gap-2 py-1">
          <StatusDot status={s.status} />
          <span className="text-[12px] font-body text-foreground/75 flex-1 capitalize">
            {s.phase}
          </span>
          {s.summary && (
            <span className="text-[9px] font-mono text-muted-foreground/55 tabular-nums">
              {s.summary}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function StatusDot({ status }: { status: ScanPhaseStatus }) {
  const base = "w-3 h-3 rounded-full shrink-0 text-[8px] font-bold text-background flex items-center justify-center";
  switch (status) {
    case "pending":
      return <span className={`${base} border border-border/60`} aria-hidden="true" />;
    case "running":
      return <span className={`${base} border border-primary/80 animate-status-pulse`} aria-hidden="true" />;
    case "complete":
      return <span className={`${base} bg-success/80`} aria-hidden="true">{"✓"}</span>;
    case "failed":
      return <span className={`${base} bg-destructive/80`} aria-hidden="true">{"✗"}</span>;
  }
}

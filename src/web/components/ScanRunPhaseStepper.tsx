/**
 * ScanRunPhaseStepper — stateless left-sidebar stepper for the scan-run
 * detail page. Renders the three scan phases (Probe -> Triage -> Investigate)
 * as dot-status rows. The parent computes the state; this component only
 * renders.
 *
 * Visual pattern matches the dot indicators used in `RecentScansSection`
 * and `HealthStrip` (bg-success/bg-destructive/bg-primary), and the running
 * animation matches the project's `animate-status-pulse` convention (see
 * `PhaseStepper.tsx`).
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
    <ul className="space-y-3 text-sm">
      {states.map((s) => (
        <li key={s.phase} className="flex items-center gap-2">
          <StatusDot status={s.status} />
          <span className="capitalize text-foreground/85">{s.phase}</span>
          {s.summary && (
            <span className="text-xs text-muted-foreground/70">
              &middot; {s.summary}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function StatusDot({ status }: { status: ScanPhaseStatus }) {
  const className = (() => {
    switch (status) {
      case "pending":
        return "h-2 w-2 rounded-full bg-muted-foreground/30";
      case "running":
        return "h-2 w-2 rounded-full bg-primary animate-status-pulse";
      case "complete":
        return "h-2 w-2 rounded-full bg-success";
      case "failed":
        return "h-2 w-2 rounded-full bg-destructive";
    }
  })();
  return <span className={className} aria-hidden="true" />;
}

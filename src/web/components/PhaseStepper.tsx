import { cn } from "@/lib/utils";
import type { PhaseStats } from "../../shared/ws-types.js";

export type PhaseStatus = "pending" | "running" | "complete" | "failed";

export interface PhaseState {
  name: string;
  label: string;
  status: PhaseStatus;
  substatus?: string;
  stats?: PhaseStats;
}

const icons: Record<PhaseStatus, string> = {
  complete: "\u2713",
  failed: "\u2717",
  running: "\u25C9",
  pending: "\u25CB",
};

export function PhaseStepper({ phases }: { phases: PhaseState[] }) {
  return (
    <div className="space-y-0">
      {phases.map((phase, i) => (
        <div key={phase.name} className="flex gap-3.5 animate-fade-up" style={{ animationDelay: `${i * 0.06}s` }}>
          {/* Indicator column */}
          <div className="flex flex-col items-center">
            <div className={cn(
              "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all duration-500",
              phase.status === "complete" && "bg-success border-success text-success-foreground glow-green",
              phase.status === "running" && "border-primary text-primary animate-glow-pulse",
              phase.status === "failed" && "bg-destructive border-destructive text-destructive-foreground glow-red",
              phase.status === "pending" && "border-border/60 text-muted-foreground/25",
            )}>
              {icons[phase.status]}
            </div>
            {i < phases.length - 1 && (
              <div className={cn(
                "w-px flex-1 min-h-[20px] transition-all duration-500",
                phase.status === "complete" ? "bg-success/50" :
                phase.status === "running" ? "bg-primary/30" :
                "bg-border/40"
              )} />
            )}
          </div>

          {/* Label column */}
          <div className="pb-5 pt-0.5">
            <p className={cn(
              "text-sm font-body font-medium leading-7 transition-colors duration-300",
              phase.status === "complete" && "text-foreground/80",
              phase.status === "running" && "text-primary",
              phase.status === "failed" && "text-destructive",
              phase.status === "pending" && "text-muted-foreground/30",
            )}>
              {phase.label}
            </p>
            {phase.substatus && (
              <p className="text-[11px] font-mono text-muted-foreground/50 mt-0.5 animate-fade-in">
                {phase.substatus}
              </p>
            )}
            {phase.stats && phase.status === "complete" && (
              <div className="flex flex-wrap gap-1 mt-1.5 animate-fade-in">
                {phase.stats.observationCount > 0 && (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary/60 border border-primary/15">
                    {phase.stats.observationCount} found
                  </span>
                )}
                {phase.stats.criticalCount > 0 && (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-destructive/10 text-destructive/60 border border-destructive/15">
                    {phase.stats.criticalCount} critical
                  </span>
                )}
                {phase.stats.toolCalls > 0 && (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-secondary/40 text-muted-foreground/40 border border-border/20">
                    {phase.stats.toolCalls} tools
                  </span>
                )}
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-secondary/40 text-muted-foreground/40 border border-border/20">
                  {phase.stats.durationMs < 1000 ? `${phase.stats.durationMs}ms` : `${(phase.stats.durationMs / 1000).toFixed(1)}s`}
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

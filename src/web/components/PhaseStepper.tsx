import { cn } from "@/lib/utils";

export type PhaseStatus = "pending" | "running" | "complete" | "failed";

export interface PhaseState {
  name: string;
  label: string;
  status: PhaseStatus;
  substatus?: string;
}

export function PhaseStepper({ phases }: { phases: PhaseState[] }) {
  return (
    <div className="space-y-0">
      {phases.map((phase, i) => (
        <div key={phase.name} className="flex gap-3">
          <div className="flex flex-col items-center">
            <div className={cn(
              "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all duration-300",
              phase.status === "complete" && "bg-green-500 border-green-500 text-white",
              phase.status === "running" && "border-blue-500 text-blue-500 animate-pulse",
              phase.status === "failed" && "bg-red-500 border-red-500 text-white",
              phase.status === "pending" && "border-muted-foreground/30 text-muted-foreground/30",
            )}>
              {phase.status === "complete" ? "\u2713" : phase.status === "failed" ? "\u2717" : phase.status === "running" ? "\u25C9" : "\u25CB"}
            </div>
            {i < phases.length - 1 && (
              <div className={cn("w-0.5 flex-1 min-h-[24px] transition-colors duration-300", phase.status === "complete" ? "bg-green-500" : "bg-muted-foreground/20")} />
            )}
          </div>
          <div className="pb-6">
            <p className={cn(
              "text-sm font-medium leading-6 transition-colors",
              phase.status === "complete" && "text-foreground",
              phase.status === "running" && "text-blue-500",
              phase.status === "failed" && "text-red-500",
              phase.status === "pending" && "text-muted-foreground/50",
            )}>
              {phase.label}
            </p>
            {phase.substatus && (
              <p className="text-xs text-muted-foreground mt-0.5">{phase.substatus}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

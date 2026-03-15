import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { PhaseStats } from "../../types/ws-types.js";
import type { TimelineEvent } from "./ActivityTimeline";

export type PhaseStatus = "pending" | "running" | "complete" | "failed";

export interface PhaseState {
  name: string;
  label: string;
  status: PhaseStatus;
  substatus?: string;
  stats?: PhaseStats;
}

interface PhaseStepperProps {
  phases: PhaseState[];
  events?: TimelineEvent[];
  evidence?: Record<string, unknown>;
  isComplete?: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ToolCallRow({ tc }: { tc: Extract<TimelineEvent, { type: "tool_call" }> }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex items-start gap-2 py-0.5">
      <div className="mt-1.5 shrink-0">
        {tc.status === "success" ? (
          <div className="w-1.5 h-1.5 rounded-full bg-success" />
        ) : tc.status === "error" ? (
          <div className="w-1.5 h-1.5 rounded-full bg-destructive" />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-primary animate-status-pulse" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="font-mono text-[11px] text-foreground/55 hover:text-primary transition-colors cursor-pointer"
          >
            {tc.tool}
          </button>
          {tc.durationMs !== undefined && (
            <span className={cn(
              "text-[9px] font-mono",
              tc.durationMs < 2000 ? "text-success/50" :
              tc.durationMs < 5000 ? "text-accent/50" :
              "text-destructive/50"
            )}>
              {formatDuration(tc.durationMs)}
            </span>
          )}
        </div>
        {expanded && tc.result && (
          <pre className="text-[10px] font-mono text-muted-foreground/35 bg-background/30 rounded p-2 mt-1 overflow-x-auto border border-border/10 max-h-20 overflow-y-auto animate-fade-in">
            {tc.result.slice(0, 500)}
          </pre>
        )}
      </div>
    </div>
  );
}

function PhaseDetails({ phase, events, evidence }: { phase: PhaseState; events: TimelineEvent[]; evidence?: unknown }) {
  const phaseEvents = events.filter((e) => e.phase === phase.name);
  const toolCalls = phaseEvents.filter((e): e is Extract<TimelineEvent, { type: "tool_call" }> => e.type === "tool_call");
  const iterations = phaseEvents.filter((e): e is Extract<TimelineEvent, { type: "iteration" }> => e.type === "iteration");

  // Extract observations from evidence
  const obs = evidence as Record<string, unknown> | undefined;
  const observations = obs && Array.isArray(obs["observations"]) ? obs["observations"] as string[] : [];

  // Separate "rich" iterations (with meaningful descriptions) from plain counter iterations
  const richIterations = iterations.filter((it) =>
    it.description && !it.description.match(/^Iteration \d/i) && it.description.length > 10
  );
  const counterIterations = iterations.filter((it) => !richIterations.includes(it));

  if (toolCalls.length === 0 && iterations.length === 0 && observations.length === 0) {
    return null;
  }

  // Deduplicate counter iterations — only show the max count
  const maxIteration = counterIterations.length > 0
    ? Math.max(...counterIterations.map((it) => it.iteration + 1))
    : 0;
  const maxOfMax = counterIterations.length > 0 ? counterIterations[0]!.maxIterations : 0;

  return (
    <div className="mt-1.5 space-y-1.5 text-[11px]">
      {/* Compact iteration counter */}
      {maxIteration > 0 && (
        <div className="flex items-center gap-1.5 text-[9px] font-mono text-muted-foreground/35">
          <div className="h-px w-2 bg-border/30" />
          {maxIteration}/{maxOfMax} iterations
          <div className="h-px flex-1 bg-border/15" />
        </div>
      )}

      {/* Rich iteration descriptions (hypotheses, reasoning, summaries) */}
      {richIterations.length > 0 && (
        <div className="space-y-1 py-1">
          {richIterations.map((it, i) => (
            <p key={i} className="text-[11px] text-foreground/55 font-body leading-relaxed pl-0.5">
              {it.description}
            </p>
          ))}
        </div>
      )}

      {/* Tool calls — the main content */}
      {toolCalls.length > 0 && (
        <div className="space-y-0">
          {toolCalls.map((tc, i) => (
            <ToolCallRow key={i} tc={tc} />
          ))}
        </div>
      )}

      {/* Observations from evidence */}
      {observations.length > 0 && (
        <div className="mt-1 p-2 rounded-md bg-secondary/20 border border-border/15 space-y-1">
          <p className="text-[9px] font-display font-semibold uppercase tracking-[0.12em] text-muted-foreground/40 mb-0.5">Findings</p>
          {observations.map((o, i) => (
            <p key={i} className="text-[11px] text-foreground/55 font-mono leading-relaxed">
              {typeof o === "string" ? o : JSON.stringify(o)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

const statusIcons: Record<PhaseStatus, string> = {
  complete: "\u2713",
  failed: "\u2717",
  running: "\u25C9",
  pending: "\u25CB",
};

export function PhaseStepper({ phases, events = [], evidence = {}, isComplete = false }: PhaseStepperProps) {
  const [openPhases, setOpenPhases] = useState<Set<string>>(new Set());
  const prevCompleteRef = useRef(isComplete);

  // Auto-open running phases, auto-close all when investigation completes
  useEffect(() => {
    if (isComplete && !prevCompleteRef.current) {
      // Investigation just completed — collapse everything
      setOpenPhases(new Set());
    } else if (!isComplete) {
      // During investigation — open running phases
      const running = phases.filter((p) => p.status === "running").map((p) => p.name);
      if (running.length > 0) {
        setOpenPhases((prev) => {
          const next = new Set(prev);
          for (const name of running) next.add(name);
          return next;
        });
      }
    }
    prevCompleteRef.current = isComplete;
  }, [isComplete, phases]);

  const toggle = (name: string) => {
    setOpenPhases((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="space-y-0">
      {phases.map((phase, i) => {
        const hasDetails = phase.status === "complete" || phase.status === "running" || phase.status === "failed";
        const phaseEvents = events.filter((e) => e.phase === phase.name);
        const phaseEvidence = evidence[phase.name];
        const hasContent = phaseEvents.length > 0 || phaseEvidence;
        const isOpen = openPhases.has(phase.name);

        return (
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
                {statusIcons[phase.status]}
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

            {/* Content column */}
            <div className="pb-3 pt-0.5 flex-1 min-w-0">
              {hasDetails && hasContent ? (
                <Collapsible open={isOpen} onOpenChange={() => toggle(phase.name)}>
                  <CollapsibleTrigger className="flex items-center gap-2 group cursor-pointer w-full text-left">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" className={cn(
                      "transition-transform duration-200 text-muted-foreground/30 shrink-0",
                      isOpen && "rotate-90"
                    )}>
                      <path d="M8 5l8 7-8 7z"/>
                    </svg>
                    <p className={cn(
                      "text-sm font-body font-medium leading-7 transition-colors duration-300",
                      phase.status === "complete" && "text-foreground/70 group-hover:text-foreground/90",
                      phase.status === "running" && "text-primary",
                      phase.status === "failed" && "text-destructive",
                    )}>
                      {phase.label}
                    </p>
                    {phase.stats && phase.status === "complete" && (
                      <div className="flex gap-1 ml-auto">
                        {phase.stats.toolCalls > 0 && (
                          <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-secondary/30 text-muted-foreground/35 border border-border/15">
                            {phase.stats.toolCalls} tools
                          </span>
                        )}
                        <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-secondary/30 text-muted-foreground/35 border border-border/15">
                          {formatDuration(phase.stats.durationMs)}
                        </span>
                      </div>
                    )}
                  </CollapsibleTrigger>
                  {phase.substatus && (
                    <p className="text-[10px] font-mono text-muted-foreground/40 mt-0.5 ml-5 animate-fade-in">
                      {phase.substatus}
                    </p>
                  )}
                  <CollapsibleContent className="ml-5">
                    <PhaseDetails phase={phase} events={events} evidence={phaseEvidence} />
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <>
                  <p className={cn(
                    "text-sm font-body font-medium leading-7 transition-colors duration-300",
                    phase.status === "complete" && "text-foreground/70",
                    phase.status === "running" && "text-primary",
                    phase.status === "failed" && "text-destructive",
                    phase.status === "pending" && "text-muted-foreground/25",
                  )}>
                    {phase.label}
                  </p>
                  {phase.substatus && (
                    <p className="text-[10px] font-mono text-muted-foreground/40 mt-0.5 animate-fade-in">
                      {phase.substatus}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatTimestamp } from "../lib/formatTimestamp";

export type TimelineEvent =
  | { type: "tool_call"; phase: string; tool: string; args: Record<string, unknown>; status: "calling" | "success" | "error"; result?: string; durationMs?: number; timestamp: number }
  | { type: "iteration"; phase: string; iteration: number; maxIterations: number; description: string; timestamp: number }
  | { type: "phase_change"; phase: string; status: "running" | "complete" | "failed"; stats?: { toolCalls: number; iterations: number; durationMs: number }; timestamp: number };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimeAgo(ts: number): string {
  return formatTimestamp(new Date(ts).toISOString(), "relative");
}

function durationColor(ms: number): string {
  if (ms < 2000) return "text-success/70";
  if (ms < 5000) return "text-accent/70";
  return "text-destructive/70";
}

function ToolCallEvent({ event }: { event: Extract<TimelineEvent, { type: "tool_call" }> }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex items-start gap-2.5 py-1 animate-fade-up">
      <div className="mt-1.5 shrink-0">
        {event.status === "calling" ? (
          <div className="w-1.5 h-1.5 rounded-full bg-primary animate-status-pulse" />
        ) : event.status === "success" ? (
          <div className="w-1.5 h-1.5 rounded-full bg-success" />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-destructive" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="ghost"
            onClick={() => setExpanded(!expanded)}
            className="font-mono text-[11px] text-foreground/60 hover:text-primary h-auto p-0 transition-colors cursor-pointer"
          >
            {event.tool}
          </Button>
          {event.durationMs !== undefined && (
            <span className={`text-[9px] font-mono ${durationColor(event.durationMs)}`}>
              {formatDuration(event.durationMs)}
            </span>
          )}
          <span className="text-[8px] font-mono text-muted-foreground/50 ml-auto shrink-0">
            {formatTimeAgo(event.timestamp)}
          </span>
        </div>
        {expanded && (
          <div className="mt-1.5 space-y-1 animate-fade-in">
            <pre className="text-[10px] font-mono text-muted-foreground/65 bg-background/30 rounded p-2 overflow-x-auto border border-border/10">
              {JSON.stringify(event.args, null, 2)}
            </pre>
            {event.result && (
              <pre className="text-[10px] font-mono text-muted-foreground/60 bg-background/30 rounded p-2 overflow-x-auto border border-border/10 max-h-24 overflow-y-auto">
                {event.result}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function IterationEvent({ event }: { event: Extract<TimelineEvent, { type: "iteration" }> }) {
  return (
    <div className="flex items-center gap-2.5 py-1 animate-fade-in">
      <div className="h-px flex-1 bg-border/20" />
      <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">
        Iteration {event.iteration + 1}/{event.maxIterations}
      </span>
      <div className="h-px flex-1 bg-border/20" />
    </div>
  );
}

function PhaseChangeEvent({ event }: { event: Extract<TimelineEvent, { type: "phase_change" }> }) {
  if (event.status === "running") {
    return (
      <div className="flex items-center gap-2 py-1.5 animate-fade-up">
        <div className="w-0.5 h-3.5 rounded-full bg-primary/40" />
        <span className="text-[10px] font-mono font-semibold text-primary/60 uppercase tracking-[0.12em]">
          {event.phase}
        </span>
        <div className="h-px flex-1 bg-primary/10" />
      </div>
    );
  }

  const statsText = event.stats
    ? `${event.stats.toolCalls} tools \u00b7 ${event.stats.iterations} iter \u00b7 ${formatDuration(event.stats.durationMs)}`
    : "";

  return (
    <div className="flex items-center gap-2 py-1.5 animate-fade-up">
      <div className={`w-0.5 h-3.5 rounded-full ${event.status === "complete" ? "bg-success/40" : "bg-destructive/40"}`} />
      <span className={`text-[10px] font-mono font-semibold uppercase tracking-[0.12em] ${event.status === "complete" ? "text-success/60" : "text-destructive/60"}`}>
        {event.phase} {event.status === "complete" ? "\u2713" : "\u2717"}
      </span>
      {statsText && (
        <span className="text-[8px] font-mono text-muted-foreground/55">{statsText}</span>
      )}
      <div className="h-px flex-1 bg-border/10" />
    </div>
  );
}

export function ActivityTimeline({ events }: { events: TimelineEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [events.length, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  if (events.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="flex items-center justify-center gap-1.5 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-primary/50 animate-status-pulse" />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-status-pulse" style={{ animationDelay: "0.3s" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/30 animate-status-pulse" style={{ animationDelay: "0.6s" }} />
          </div>
          <p className="text-[11px] font-mono text-muted-foreground/60">Waiting for investigation...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full relative">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-4 py-3">
        {events.map((event, i) => {
          switch (event.type) {
            case "tool_call":
              return <ToolCallEvent key={i} event={event} />;
            case "iteration":
              return <IterationEvent key={i} event={event} />;
            case "phase_change":
              return <PhaseChangeEvent key={i} event={event} />;
          }
        })}
      </div>
      {!autoScroll && (
        <Button
          variant="ghost"
          onClick={() => { setAutoScroll(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }}
          className="absolute bottom-3 right-3 px-2.5 py-1 h-auto rounded-full bg-primary/15 border border-primary/25 text-[10px] font-mono text-primary/70 hover:bg-primary/25 transition-colors"
        >
          scroll to bottom
        </Button>
      )}
    </div>
  );
}

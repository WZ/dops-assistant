import { useEffect, useRef, useState } from "react";

export type TimelineEvent =
  | { type: "tool_call"; phase: string; tool: string; args: Record<string, unknown>; status: "calling" | "success" | "error"; result?: string; durationMs?: number; timestamp: number }
  | { type: "iteration"; phase: string; iteration: number; maxIterations: number; description: string; timestamp: number }
  | { type: "phase_change"; phase: string; status: "running" | "complete" | "failed"; stats?: { toolCalls: number; iterations: number; durationMs: number }; timestamp: number };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ago`;
}

function durationColor(ms: number): string {
  if (ms < 2000) return "text-success/70";
  if (ms < 5000) return "text-accent/70";
  return "text-destructive/70";
}

function ToolCallEvent({ event }: { event: Extract<TimelineEvent, { type: "tool_call" }> }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex items-start gap-2.5 py-1.5 animate-fade-up">
      <div className="mt-1 shrink-0">
        {event.status === "calling" ? (
          <div className="w-2 h-2 rounded-full bg-primary animate-status-pulse" />
        ) : event.status === "success" ? (
          <div className="w-2 h-2 rounded-full bg-success" />
        ) : (
          <div className="w-2 h-2 rounded-full bg-destructive" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setExpanded(!expanded)}
            className="font-mono text-[11px] text-foreground/70 hover:text-primary transition-colors cursor-pointer"
          >
            {event.tool}
          </button>
          {event.durationMs !== undefined && (
            <span className={`text-[10px] font-mono ${durationColor(event.durationMs)}`}>
              {formatDuration(event.durationMs)}
            </span>
          )}
          <span className="text-[9px] font-mono text-muted-foreground/25 ml-auto shrink-0">
            {formatTimeAgo(event.timestamp)}
          </span>
        </div>
        {expanded && (
          <div className="mt-1.5 space-y-1 animate-fade-in">
            <pre className="text-[10px] font-mono text-muted-foreground/40 bg-background/40 rounded p-2 overflow-x-auto border border-border/15">
              {JSON.stringify(event.args, null, 2)}
            </pre>
            {event.result && (
              <pre className="text-[10px] font-mono text-muted-foreground/35 bg-background/40 rounded p-2 overflow-x-auto border border-border/15 max-h-24 overflow-y-auto">
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
      <span className="text-[10px] font-mono text-muted-foreground/30 shrink-0">
        Iteration {event.iteration + 1}/{event.maxIterations}
      </span>
      <div className="h-px flex-1 bg-border/20" />
    </div>
  );
}

function PhaseChangeEvent({ event }: { event: Extract<TimelineEvent, { type: "phase_change" }> }) {
  if (event.status === "running") {
    return (
      <div className="flex items-center gap-2 py-2 animate-fade-up">
        <div className="w-1 h-4 rounded-full bg-primary/50" />
        <span className="text-[11px] font-display font-semibold text-primary/70 uppercase tracking-wide">
          {event.phase}
        </span>
        <div className="h-px flex-1 bg-primary/15" />
      </div>
    );
  }

  const statsText = event.stats
    ? `${event.stats.toolCalls} tools \u00b7 ${event.stats.iterations} iter \u00b7 ${formatDuration(event.stats.durationMs)}`
    : "";

  return (
    <div className="flex items-center gap-2 py-2 animate-fade-up">
      <div className={`w-1 h-4 rounded-full ${event.status === "complete" ? "bg-success/50" : "bg-destructive/50"}`} />
      <span className={`text-[11px] font-display font-semibold uppercase tracking-wide ${event.status === "complete" ? "text-success/70" : "text-destructive/70"}`}>
        {event.phase} {event.status === "complete" ? "\u2713" : "\u2717"}
      </span>
      {statsText && (
        <span className="text-[9px] font-mono text-muted-foreground/30">{statsText}</span>
      )}
      <div className="h-px flex-1 bg-border/15" />
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
          <p className="text-[11px] font-mono text-muted-foreground/30">Waiting for investigation...</p>
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
        <button
          onClick={() => { setAutoScroll(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }}
          className="absolute bottom-3 right-3 px-2.5 py-1 rounded-full bg-primary/15 border border-primary/25 text-[10px] font-mono text-primary/70 hover:bg-primary/25 transition-colors"
        >
          scroll to bottom
        </button>
      )}
    </div>
  );
}

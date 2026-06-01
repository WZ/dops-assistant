import type { AgentStreamEvent, AgentStreamStats } from "../../types/ws-types.js";

/**
 * Dedicated, structured agent stream for deep mode (Step 3) — colored verbs,
 * query targets in info-blue, status icons, indented sub-steps with a left rail,
 * and a footer of run stats. Always expanded (unlike the chat "thinking" block).
 * Matches the "LIVE · AGENT STREAM" design.
 */

const STATUS_ICON: Record<AgentStreamEvent["status"], string> = {
  running: "◉",
  done: "✓",
  rejected: "✗",
  strong: "✓",
};

// Icon color by status; verbs reuse the same intent so the eye groups by outcome.
function statusClass(status: AgentStreamEvent["status"]): string {
  switch (status) {
    case "running": return "text-primary";
    case "strong": return "text-success";
    case "rejected": return "text-destructive";
    default: return "text-muted-foreground";
  }
}
function verbClass(status: AgentStreamEvent["status"]): string {
  switch (status) {
    case "strong": return "text-success";
    case "rejected": return "text-destructive";
    default: return "text-accent/90"; // coral for actions, matching the design
  }
}

export function DeepModeStream({
  events,
  stats,
  running,
}: {
  events: AgentStreamEvent[];
  stats?: AgentStreamStats;
  running: boolean;
}) {
  if (events.length === 0 && !running) return null;
  return (
    <section className="rounded-lg border border-accent/30 bg-card overflow-hidden animate-fade-up">
      <div className="px-4 py-2 border-b border-border/60 flex items-center gap-2">
        {running && <span className="w-2 h-2 rounded-full bg-accent animate-[status-pulse_1.8s_ease-in-out_infinite]" />}
        <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-accent/80">
          Deep Mode · re-examination{running ? " · live" : ""}
        </span>
      </div>

      <div className="px-4 py-3 font-mono text-[12px] leading-[1.75]">
        {events.map((e) => (
          <div
            key={e.seq}
            className={`flex items-start gap-2 ${e.indent ? "ml-5 pl-3 border-l border-border/60" : ""}`}
          >
            <span className={`shrink-0 ${statusClass(e.status)} ${e.status === "running" ? "animate-pulse" : ""}`}>
              {STATUS_ICON[e.status]}
            </span>
            <span className="min-w-0 break-words">
              <span className={`font-medium ${verbClass(e.status)}`}>{e.verb}</span>
              {e.target && (
                <span className={e.targetKind === "query" ? "text-info" : "text-foreground/90"}> {e.target}</span>
              )}
              {e.detail && <span className="text-muted-foreground/70"> {e.detail}</span>}
            </span>
          </div>
        ))}
      </div>

      {stats && (
        <div className="px-4 py-2 border-t border-border/60 font-mono text-[10px] text-muted-foreground/70 flex gap-4 flex-wrap">
          <span>examined <span className="text-foreground/80">{stats.examined}</span></span>
          <span>tools <span className="text-foreground/80">{stats.toolCalls}</span></span>
          {stats.resurrected > 0 && <span>resurrected <span className="text-warning">{stats.resurrected}</span></span>}
          {stats.shaken > 0 && <span>shaken <span className="text-warning">{stats.shaken}</span></span>}
          <span>elapsed <span className="text-foreground/80">{(stats.durationMs / 1000).toFixed(1)}s</span></span>
        </div>
      )}
    </section>
  );
}

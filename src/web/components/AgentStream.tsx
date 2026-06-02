import type { AgentStreamEvent } from "../../types/ws-types.js";

/**
 * Shared structured agent stream — colored verbs, query targets in info-blue,
 * status icons, indented sub-steps with a left rail, and a generic footer.
 * Always expanded (unlike the chat "thinking" block). Used by both the
 * deep-mode stream and the autonomous orchestrator; each supplies its own
 * header label and footer items.
 */

export type AgentStreamFooterItem = {
  label: string;
  value: string | number;
  tone?: "default" | "warn" | "good";
};

/** Terminal outcome callout shown once the run finishes (above the footer). */
export type AgentStreamBanner = {
  text: string;
  tone: "good" | "warn" | "muted";
};

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
function toneClass(tone: AgentStreamFooterItem["tone"]): string {
  switch (tone) {
    case "warn": return "text-warning";
    case "good": return "text-success";
    default: return "text-foreground/80";
  }
}

const BANNER_CLASS: Record<AgentStreamBanner["tone"], string> = {
  good: "bg-success/8 border-success/20 text-success/90",
  warn: "bg-warning/8 border-warning/25 text-warning/90",
  muted: "bg-muted/40 border-border/60 text-muted-foreground",
};

export function AgentStream({
  label,
  events,
  footer,
  banner,
  running,
}: {
  label: string;
  events: AgentStreamEvent[];
  footer?: AgentStreamFooterItem[];
  banner?: AgentStreamBanner;
  running: boolean;
}) {
  if (events.length === 0 && !running) return null;
  return (
    <section className="rounded-lg border border-accent/30 bg-card overflow-hidden animate-fade-up">
      <div className="px-4 py-2 border-b border-border/60 flex items-center gap-2">
        {running && <span className="w-2 h-2 rounded-full bg-accent animate-[status-pulse_1.8s_ease-in-out_infinite]" />}
        <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-accent/80">
          {label}{running ? " · live" : ""}
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

      {banner && !running && (
        <div className={`mx-4 mb-1 px-3 py-2 rounded-md border font-body text-[12px] ${BANNER_CLASS[banner.tone]}`}>
          {banner.text}
        </div>
      )}

      {footer && footer.length > 0 && (
        <div className="px-4 py-2 border-t border-border/60 font-mono text-[10px] text-muted-foreground/70 flex gap-4 flex-wrap">
          {footer.map((f) => (
            <span key={f.label}>
              {f.label} <span className={toneClass(f.tone)}>{f.value}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

import { useEffect, useState } from "react";
import type { AgentStreamEvent } from "../../types/ws-types.js";

/** Ticking "Ns" since the run went live — proves the agent is alive between
 *  steps (decideMove thinking, a long query, a running subagent), so the stream
 *  never looks hung. Anchored to `startedAt` (the run's start, from the registry)
 *  when supplied, so the count survives this component remounting (e.g. the
 *  operator navigates away from the Console and back); falls back to mount time. */
function useElapsedSeconds(running: boolean, startedAt?: number): number {
  const since = (anchor: number) => Math.max(0, Math.floor((Date.now() - anchor) / 1000));
  const [elapsed, setElapsed] = useState(() => (startedAt != null ? since(startedAt) : 0));
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const start = startedAt ?? Date.now();
    setElapsed(since(start));
    const id = setInterval(() => setElapsed(since(start)), 1000);
    return () => clearInterval(id);
  }, [running, startedAt]);
  return elapsed;
}

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
  inconclusive: "?", // couldn't verify — no evidence gathered (not a refutation)
};

// Icon color by status; verbs reuse the same intent so the eye groups by outcome.
function statusClass(status: AgentStreamEvent["status"]): string {
  switch (status) {
    case "running": return "text-primary";
    case "strong": return "text-success";
    case "rejected": return "text-destructive";
    case "inconclusive": return "text-warning";
    default: return "text-muted-foreground";
  }
}
function verbClass(status: AgentStreamEvent["status"]): string {
  switch (status) {
    case "strong": return "text-success";
    case "rejected": return "text-destructive";
    case "inconclusive": return "text-warning";
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

/** One move row — the status glyph + colored verb + target/detail. Shared by the
 *  card and inline renderings so a move reads identically in both. */
function MoveRow({ e }: { e: AgentStreamEvent }) {
  return (
    <div className={`flex items-start gap-2 ${e.indent ? "ml-5 pl-3 border-l border-border/60" : ""}`}>
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
  );
}

/**
 * The live "current move" indicator (the move effect) — a spinner + the in-flight
 * move's verb, an animated shimmer bar, the elapsed clock, and the query it's
 * running on a second line. Shows WHAT the agent is doing right now, not just that
 * it's busy. Falls back to "thinking…" between moves. Used by the inline band.
 */
function LiveMoveIndicator({ move, elapsed }: { move: AgentStreamEvent | null; elapsed: number }) {
  return (
    <div className="flex flex-col gap-0.5 pt-1">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="w-2.5 h-2.5 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0" aria-hidden />
        <span className="text-foreground/90">{move?.verb ?? "thinking"}</span>
        <span
          className="inline-block w-14 h-1 rounded bg-gradient-to-r from-transparent via-primary to-transparent bg-[length:200%_100%] animate-[shimmer_1.15s_ease-in-out_infinite]"
          aria-hidden
        />
        <span className="ml-auto text-[10px] text-muted-foreground/60 tabular-nums">{elapsed}s</span>
      </div>
      {move?.target && (
        <div className="pl-[18px] text-[10.5px] text-muted-foreground/70 truncate">
          {move.targetKind === "query" ? "querying " : ""}
          <span className="text-primary/90">{move.target}</span>
        </div>
      )}
    </div>
  );
}

export function AgentStream({
  label,
  events,
  footer,
  banner,
  running,
  startedAt,
  inline = false,
}: {
  label: string;
  events: AgentStreamEvent[];
  footer?: AgentStreamFooterItem[];
  banner?: AgentStreamBanner;
  running: boolean;
  /** Run start (epoch ms) so the live timer survives a remount. */
  startedAt?: number;
  /** Bandless rendering for the Console: no card chrome / header, settled moves
   *  in a flush list, and the trailing in-flight move shown as the shimmer
   *  "current move" indicator. The outer surface (InlineRunRegion) owns the band
   *  rule + label. */
  inline?: boolean;
}) {
  const elapsed = useElapsedSeconds(running, startedAt);
  if (events.length === 0 && !running) return null;

  if (inline) {
    // Pull the trailing in-flight move out of the list — it becomes the live
    // shimmer indicator at the bottom (the move effect), so it isn't shown twice.
    const lastRunning = running && events.length > 0 && events[events.length - 1].status === "running";
    const settled = lastRunning ? events.slice(0, -1) : events;
    const currentMove = lastRunning ? events[events.length - 1] : null;
    return (
      <div className="font-mono text-[12px] leading-[1.7]">
        {settled.map((e) => <MoveRow key={e.seq} e={e} />)}
        {running && <LiveMoveIndicator move={currentMove} elapsed={elapsed} />}
        {banner && !running && (
          <div className={`mt-1.5 px-2.5 py-1.5 rounded-md border font-body text-[12px] ${BANNER_CLASS[banner.tone]}`}>
            {banner.text}
          </div>
        )}
        {footer && footer.length > 0 && (
          <div className="mt-2 pt-1.5 border-t border-border/30 text-[10px] text-muted-foreground/60 flex gap-3.5 flex-wrap">
            {footer.map((f) => (
              <span key={f.label}>{f.label} <span className={toneClass(f.tone)}>{f.value}</span></span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-accent/30 bg-card overflow-hidden animate-fade-up">
      <div className="px-4 py-2 border-b border-border/60 flex items-center gap-2">
        {running && <span className="w-2 h-2 rounded-full bg-accent animate-[status-pulse_1.8s_ease-in-out_infinite]" />}
        <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-accent/80">
          {label}{running ? ` · live · ${elapsed}s` : ""}
        </span>
      </div>

      <div className="px-4 py-3 font-mono text-[12px] leading-[1.75]">
        {events.map((e) => <MoveRow key={e.seq} e={e} />)}
      </div>

      {running && (
        <div className="px-4 pb-2 flex items-center gap-2 font-mono text-[12px] text-accent/90">
          <span className="animate-pulse">◉</span>
          <span>working… {elapsed}s</span>
        </div>
      )}

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

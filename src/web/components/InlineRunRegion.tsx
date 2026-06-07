/**
 * InlineRunRegion (PR-1, task T3) — the Deep Investigation run rendered INLINE
 * in the Console, as a projection of the run registry (NOT a chat message).
 *
 * Layout (the approved inline wireframe): a pinned region that lives between the
 * chat thread and the composer —
 *   ┌ status strip (pulse · title · elapsed · Result|Live toggle · Stop) ┐  ← click to collapse (DZ2)
 *   │ body: Result view (result-first, default) | Live log (the move stream)│
 *   │ ephemerality notice (Full running) (D6)                              │
 *   └ docked pause bar — pinned, shown even when collapsed (DZ2/DZ8) ──────┘
 *
 * Accessibility (DZ4): a scoped assertive live-region announces STATE CHANGES +
 * the pause prompt only (never per-step), so a screen reader isn't spammed by
 * the streaming move log.
 */
import { useEffect, useRef, useState } from "react";
import {
  useOrchestratorRun,
  useOrchestratorRunActions,
  type DeepRunState,
} from "../contexts/OrchestratorRunContext";
// Shared run-view projection (PR-2d, T2) — the inline strip and the wide panel
// both render these, so the conclusion/causal-chain/move-log logic lives once.
import { fmtSeconds, liveAnnouncement, ResultView, LiveView } from "./deep-run-view";

const SEG_ON = "bg-primary/12 text-primary";
const SEG_OFF = "text-muted-foreground/60 hover:text-foreground/80";

export function InlineRunRegion({
  investigationId,
  service,
}: {
  investigationId?: string | null;
  service?: string;
}) {
  const run = useOrchestratorRun(investigationId);
  const { decide, stop, setCollapsed } = useOrchestratorRunActions();
  const [view, setView] = useState<"result" | "live">("result");

  // Live elapsed ticker while running (the run state only carries a final
  // durationMs on completion). Resets when a new run starts. An interrupted
  // (hydrated-running) run is NOT live, so the ticker stays off for it.
  const [elapsed, setElapsed] = useState(0);
  const running = !!run?.running;
  const parked = !!run?.parked && running;
  const interrupted = !!run?.hydrated && running && !parked;
  const liveRunning = running && !interrupted && !parked;
  useEffect(() => {
    if (!liveRunning) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [liveRunning, run?.kind, investigationId]);

  // DZ2: on completion, auto-fall back to the Result view (the move log
  // auto-collapses; the result stays promoted).
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && run && !run.running) setView("result");
    wasRunning.current = !!run?.running;
  }, [run?.running, run]);

  if (!investigationId || !run) return null;

  const id = investigationId;
  const collapsed = run.collapsed;
  const paused = !!run.pause;
  const locked = !!run.decisionSubmitted;
  const title = `Deep Investigation${service ? ` · ${service}` : ""}`;

  const finalSeconds =
    run.kind === "orchestrator" && run.orchStats ? run.orchStats.durationMs / 1000
    : run.kind === "deep-mode" && run.deepStats ? run.deepStats.durationMs / 1000
    : undefined;
  const elapsedLabel = liveRunning ? fmtSeconds(elapsed) : finalSeconds != null ? fmtSeconds(finalSeconds) : "";

  const pulse = parked ? "bg-warning"
    : interrupted ? "bg-muted-foreground/40"
    : run.running ? "bg-primary animate-[status-pulse_1.8s_ease-in-out_infinite]"
    : run.error ? "bg-destructive"
    : paused ? "bg-warning"
    : "bg-success";

  return (
    <div className="shrink-0 border-t border-border/60 bg-card/40">
      {/* Scoped live region — state changes + pause only (DZ4). */}
      <div aria-live="assertive" className="sr-only">{liveAnnouncement(run)}</div>

      {/* Status strip — click anywhere (except the controls) toggles collapse (DZ2). */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        <button
          type="button"
          onClick={() => setCollapsed(id, !collapsed)}
          aria-expanded={!collapsed}
          aria-label={`${title} — ${parked ? "parked" : interrupted ? "interrupted" : run.running ? "running" : "finished"}. Click to ${collapsed ? "expand" : "collapse"}.`}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${pulse}`} />
          <span className="font-medium text-[11px] truncate text-foreground/90">{title}</span>
          {elapsedLabel && <span className="font-mono text-[10px] text-muted-foreground/55 shrink-0">· {elapsedLabel}</span>}
          <span className="font-mono text-[10px] text-muted-foreground/45 ml-1 shrink-0" aria-hidden>{collapsed ? "▸" : "▾"}</span>
        </button>

        <span className="inline-flex border border-border/60 rounded-md overflow-hidden shrink-0" role="group" aria-label="View">
          <button type="button" onClick={() => setView("result")} className={`font-mono text-[9px] px-2 py-1 ${view === "result" ? SEG_ON : SEG_OFF}`}>RESULT</button>
          <button type="button" onClick={() => setView("live")} className={`font-mono text-[9px] px-2 py-1 ${view === "live" ? SEG_ON : SEG_OFF}`}>LIVE LOG</button>
        </span>

        {liveRunning && run.kind === "orchestrator" && (
          // Stop only on the abortable Full run — the server only aborts
          // orchestrator runs (activeOrchestrations). A Challenge (deep-mode)
          // run has no abort path and is seconds long, so no dead Stop button.
          // Never on an interrupted run — the server already lost it on reload.
          <button
            type="button"
            onClick={() => stop(id)}
            aria-label="Stop the deep investigation"
            className="font-mono text-[9px] px-2 py-1 rounded-md border border-border/60 text-muted-foreground hover:text-destructive hover:border-destructive/40 shrink-0"
          >
            ■ STOP
          </button>
        )}
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="px-3 py-3 max-h-[320px] overflow-auto">
          {view === "result" ? <ResultView run={run} /> : <LiveView run={run} live={liveRunning} />}
        </div>
      )}

      {/* Interrupted notice — a hydrated run with no live server-side run to
          reattach to (e.g. after a server restart). The steps shown are what
          completed before it stopped; re-run to continue. */}
      {!collapsed && interrupted && (
        <div className="mx-3 mb-2 flex gap-2 items-start rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5">
          <span className="text-muted-foreground text-[11px] leading-none mt-0.5" aria-hidden>⏸</span>
          <span className="text-[10.5px] text-foreground/80 leading-snug">
            This run was interrupted and can't be resumed here. The steps above are what completed before it stopped — re-run to continue.
          </span>
        </div>
      )}

      {/* Parked notice — the server parked a viewerless run to save tokens (PR-2c).
          It resumes automatically now that this tab is attached. */}
      {!collapsed && parked && (
        <div className="mx-3 mb-2 flex gap-2 items-start rounded-md border border-warning/30 bg-warning/8 px-2.5 py-1.5">
          <span className="text-warning text-[11px] leading-none mt-0.5" aria-hidden>⏸</span>
          <span className="text-[10.5px] text-foreground/80 leading-snug">
            This run parked itself while no one was watching, to save tokens. It resumes automatically now that you're back.
          </span>
        </div>
      )}

      {/* Docked pause bar — pinned, shown even when collapsed so a pause is never
          hidden (DZ2/DZ8). Decision routes through the registry (D7 locking).
          Suppressed when interrupted: the server lost the paused loop on reload,
          so a decision would reach nothing — the interrupted notice stands in. */}
      {paused && !interrupted && !parked && (
        <div className="border-t border-warning/30 bg-warning/8 px-3 py-2.5" role="group" aria-label="Paused — operator decision required">
          <div className="font-semibold text-[12px] text-warning mb-0.5">⚠ Paused — needs your call</div>
          <p className="text-[11px] text-foreground/80 mb-2 leading-snug">
            Ruled out {run.pause?.strikes} hypothes{(run.pause?.strikes ?? 0) === 1 ? "is" : "es"}, nothing discriminating. Continue, hand off, or wait.
          </p>
          <div className="flex gap-1.5 flex-wrap">
            <button type="button" disabled={locked} onClick={() => decide(id, "continue")}
              className="font-mono text-[10px] h-7 px-2.5 rounded-md border border-primary/40 text-primary disabled:opacity-40 disabled:cursor-not-allowed">▸ continue</button>
            <button type="button" disabled={locked} onClick={() => decide(id, "escalate")}
              className="font-mono text-[10px] h-7 px-2.5 rounded-md border border-destructive/40 text-destructive disabled:opacity-40 disabled:cursor-not-allowed">▸ escalate</button>
            <button type="button" disabled={locked} onClick={() => decide(id, "wait")}
              className="font-mono text-[10px] h-7 px-2.5 rounded-md border border-border/60 text-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed">▸ instrument &amp; wait</button>
          </div>
          {locked && <div className="text-[10px] text-success mt-1.5">✓ decision sent — controls locked</div>}
        </div>
      )}
    </div>
  );
}

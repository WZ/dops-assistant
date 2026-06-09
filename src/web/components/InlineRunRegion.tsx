/**
 * InlineRunRegion — the Deep Investigation run rendered as an INLINE BAND inside
 * the bottom-anchored chat stream (not a bolted-on card). The console-inline
 * redesign dropped the panel chrome: no bordered card, no status-strip header, no
 * RESULT/LIVE toggle, no collapse. What's left:
 *
 *   ┌ band rule — "DEEP INVESTIGATION" stamp · fading hairline · elapsed/outcome ┐
 *   │ moves (settled rows) … + the live "current move" shimmer effect            │
 *   │ — OR, once finished — the conclusion · causal chain · Grafana ↗ provenance │
 *   ├ action row (right-aligned): ■ STOP while running · Apply to report when     │
 *   │   confirmed · ↻ RE-RUN when interrupted                                     │
 *   └ docked OperatorPauseBar when the run is paused ───────────────────────────┘
 *
 * It lives at the bottom of the message scroll region, so it reads as the latest
 * thing in the thread and streams downward like the rest of the conversation.
 *
 * Accessibility (DZ4): a scoped assertive live-region announces STATE CHANGES +
 * the pause prompt only (never per-step), so a screen reader isn't spammed by the
 * streaming move log.
 */
import { useEffect, useState } from "react";
import { useOrchestratorRun, useOrchestratorRunActions } from "../contexts/OrchestratorRunContext";
import { fmtSeconds, liveAnnouncement, BandRule, ResultView, LiveView, OperatorPauseBar } from "./deep-run-view";
import { useGrafanaProviders } from "../hooks/useGrafanaProviders";

export function InlineRunRegion({
  investigationId,
  service,
}: {
  investigationId?: string | null;
  service?: string;
}) {
  const run = useOrchestratorRun(investigationId);
  const { decide, stop, accept, start, connectionStatus } = useOrchestratorRunActions();
  const providers = useGrafanaProviders();

  // Live elapsed while running. Anchored to the run's `startedAt` (held in the
  // registry), not to mount — so it keeps counting when the operator leaves the
  // Console and comes back instead of resetting to 0. The 1s tick only forces a
  // re-render; the value is computed from startedAt below.
  const [, setTick] = useState(0);
  // Stop has a delay — the server finishes the in-flight move before aborting. Show
  // "Stopping…" in that window so the button doesn't look unresponsive. Reset once
  // the run is no longer live (aborted, or a fresh run started).
  const [stopping, setStopping] = useState(false);
  const running = !!run?.running;
  const parked = !!run?.parked && running;
  const interrupted = !!run?.hydrated && running && !parked;
  const liveRunning = running && !interrupted && !parked;
  useEffect(() => {
    if (!liveRunning) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [liveRunning]);
  useEffect(() => {
    if (!liveRunning) setStopping(false);
  }, [liveRunning]);

  if (!investigationId || !run) return null;

  const id = investigationId;
  const paused = !!run.pause;
  const locked = !!run.decisionSubmitted;

  // A finished, confirmed Full (orchestrator) run can be applied back into the RCA
  // report. Operator-gated — no auto-write-back. Hidden for deep-mode / unconfirmed
  // / still-running runs.
  const canApply = run.kind === "orchestrator" && !run.running && run.outcome === "confirmed";

  const finalSeconds =
    run.kind === "orchestrator" && run.orchStats ? run.orchStats.durationMs / 1000
    : run.kind === "deep-mode" && run.deepStats ? run.deepStats.durationMs / 1000
    : undefined;
  const liveElapsed = run.startedAt != null ? Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000)) : 0;
  const elapsedLabel = liveRunning ? fmtSeconds(liveElapsed) : finalSeconds != null ? fmtSeconds(finalSeconds) : "";

  // The move log stays visible at every stage — even after the run finishes, the
  // "what it explored" progress is kept (not swapped out), like a terminal
  // transcript. A finished run with an outcome appends the conclusion + causal
  // chain + provenance below the moves.
  const showResult = !running && !!run.outcome && !interrupted && !parked;

  return (
    <div
      className="animate-fade-up pt-1"
      role="group"
      aria-label={`Deep investigation${service ? ` · ${service}` : ""}`}
    >
      {/* Scoped live region — state changes + pause only (DZ4). */}
      <div aria-live="assertive" className="sr-only">{liveAnnouncement(run)}</div>

      <BandRule run={run} elapsedLabel={elapsedLabel} />

      <LiveView run={run} live={liveRunning} inline />

      {showResult && (
        <div className="mt-2.5 pt-2.5 border-t border-border/40">
          <ResultView run={run} providers={providers} inline />
        </div>
      )}

      {/* Action row — right-aligned, below the run it controls. */}
      {(liveRunning && run.kind === "orchestrator") || canApply ? (
        <div className="flex items-center justify-end gap-2 mt-2">
          {liveRunning && run.kind === "orchestrator" && (
            // Stop only on the abortable Full run — the server only aborts
            // orchestrator runs. A Challenge (deep-mode) run has no abort path.
            stopping ? (
              <span
                className="font-mono text-[9.5px] px-2.5 py-1 rounded-md border border-border/60 text-muted-foreground/70"
                role="status"
                aria-live="polite"
              >
                ■ Stopping…
              </span>
            ) : (
              <button
                type="button"
                onClick={() => { setStopping(true); stop(id); }}
                aria-label="Stop the deep investigation"
                className="font-mono text-[9.5px] px-2.5 py-1 rounded-md border border-border/60 text-muted-foreground hover:text-destructive hover:border-destructive/40"
              >
                ■ STOP
              </button>
            )
          )}
          {canApply && (run.accepted ? (
            <span className="font-mono text-[9.5px] px-2.5 py-1 rounded-md border border-success/40 bg-success/8 text-success" role="status">
              ✓ applied to report
            </span>
          ) : run.refining ? (
            <span className="font-mono text-[9.5px] px-2.5 py-1 rounded-md border border-primary/40 bg-primary/8 text-primary/90" role="status" aria-live="polite">
              ◌ re-synthesizing report…
            </span>
          ) : (
            <button
              type="button"
              onClick={() => accept(id)}
              aria-label="Apply this confirmed deep-investigation conclusion to the RCA report"
              className="font-mono text-[9.5px] px-2.5 py-1 rounded-md border border-primary/40 text-primary/90 hover:bg-primary/8 hover:text-primary"
            >
              Apply to report
            </button>
          ))}
        </div>
      ) : null}

      {/* Interrupted notice — a hydrated run with no live server-side run to
          reattach to (e.g. after a server restart). A fresh run can be launched. */}
      {interrupted && (
        <div className="mt-2 flex gap-2 items-center justify-between rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5">
          <div className="flex gap-2 items-start min-w-0">
            <span className="text-muted-foreground text-[11px] leading-none mt-0.5" aria-hidden>⏸</span>
            <span className="text-[10.5px] text-foreground/80 leading-snug">
              This run was interrupted and can't be resumed here. The steps above are what completed before it stopped.
            </span>
          </div>
          <button
            type="button"
            onClick={() => start(id, run.kind === "deep-mode" ? "challenge" : "full")}
            disabled={connectionStatus !== "connected"}
            aria-label="Re-run this deep investigation from the start"
            className="shrink-0 font-mono text-[9.5px] px-2 py-1 rounded-md border border-primary/40 text-primary/90 hover:bg-primary/8 hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ↻ RE-RUN
          </button>
        </div>
      )}

      {/* Parked notice — the server parked a viewerless run to save tokens (PR-2c).
          It resumes automatically now that this tab is attached. */}
      {parked && (
        <div className="mt-2 flex gap-2 items-start rounded-md border border-warning/30 bg-warning/8 px-2.5 py-1.5">
          <span className="text-warning text-[11px] leading-none mt-0.5" aria-hidden>⏸</span>
          <span className="text-[10.5px] text-foreground/80 leading-snug">
            This run parked itself while no one was watching, to save tokens. It resumes automatically now that you're back.
          </span>
        </div>
      )}

      {/* Apply-to-report rejection notice (PR-6b). Shown until the next attempt. */}
      {run.acceptError && (
        <div className="mt-2 flex gap-2 items-start rounded-md border border-destructive/30 bg-destructive/8 px-2.5 py-1.5" role="alert">
          <span className="text-destructive text-[11px] leading-none mt-0.5" aria-hidden>!</span>
          <span className="text-[10.5px] text-foreground/80 leading-snug">{run.acceptError}</span>
        </div>
      )}

      {/* Docked pause bar — decision routes through the registry (D7 locking).
          Suppressed when interrupted: the server lost the paused loop on reload. */}
      {paused && !interrupted && !parked && (
        <div className="mt-2 rounded-md overflow-hidden">
          <OperatorPauseBar
            size="compact"
            strikes={run.pause?.strikes}
            locked={locked}
            operatorContext={run.operatorContext}
            onDecide={(decision, context) => decide(id, decision, context)}
          />
        </div>
      )}
    </div>
  );
}

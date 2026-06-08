/**
 * DeepInvestigationPanel (PR-2d, T4) — the wide, dedicated home for a Deep
 * Investigation run at /stacks/:stackId/investigations/:id/deep (Variant D, the
 * approved "durable dossier" layout). It is a focused, full-pane view of the SAME
 * run the Console inline strip projects — both read `useOrchestratorRun(id)` and
 * render the shared `deep-run-view` pieces, so there is no divergent copy.
 *
 *   ┌ header: [← Back] Deep Investigation · service   ● status · elapsed/outcome  [■ Stop] ┐
 *   │ ┌ result column (result-first: conclusion → causal chain → trace) ──────────────────┐│
 *   │ │  <ResultView>  | empty → <ScopedDeepMenu> start CTA | not-found                   ││
 *   │ ├ move log ───────────────────────────────────────────────────────────────────────┤│
 *   │ │  <LiveView live>                                                                  ││
 *   │ └ parked / interrupted notice                                                       ││
 *   │ docked pause bar (decide — D7 cross-tab locking)                                      │
 *   └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Cold-load + reattach come from the shared `useInvestigationRunHydration` hook
 * (GET → /locate redirect → hydrate → subscribe), identical to the detail page.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useOrchestratorRun, useOrchestratorRunActions } from "../contexts/OrchestratorRunContext";
import { useInvestigationRunHydration } from "../hooks/useInvestigationRunHydration";
import { ScopedDeepMenu } from "./ScopedDeepMenu";
import { ResultView, LiveView, fmtSeconds, isParked, isInterrupted, liveAnnouncement, OperatorPauseBar, RevisionDiff, computeRevision } from "./deep-run-view";
import { useGrafanaProviders } from "../hooks/useGrafanaProviders";
import type { RcaReport } from "../../types/rca-types";

/** Best-effort: does the report carry a loop outcome / ruled-out causes that the
 *  "Challenge this RCA" (deep-mode) scope can re-judge? Drives the empty-state menu. */
function reportCanChallenge(reportJson: string | null | undefined): boolean {
  if (!reportJson) return false;
  try {
    const r = JSON.parse(reportJson);
    return !!r.loopOutcome || (Array.isArray(r.ruledOut) && r.ruledOut.length > 0);
  } catch {
    return false;
  }
}

export function DeepInvestigationPanel({
  investigationId,
  onBack,
  onWrongStack,
  service: serviceProp,
}: {
  investigationId: string;
  /** Return to the originating detail/console view. */
  onBack: () => void;
  onWrongStack?: (correctStackId: string) => void;
  /** Service name when the caller already knows it (live launch) — avoids a flash
   *  before the cold GET resolves. Falls back to the fetched payload. */
  service?: string;
}) {
  // The panel is always a cold/deep surface (never the live "active" pane), so
  // the hook always does its GET + hydrate + subscribe.
  const { data, notFound } = useInvestigationRunHydration(investigationId, { active: false, onWrongStack });
  const run = useOrchestratorRun(investigationId);
  const { decide, stop } = useOrchestratorRunActions();
  const providers = useGrafanaProviders();

  const service = serviceProp || data?.investigation.service || "";
  const canChallenge = reportCanChallenge(data?.investigation.report);
  // The original RCA report this deep run was launched from, for the revision diff
  // (PR-5). Parsed once; null on absent/malformed JSON → no diff (graceful).
  const originalReport = useMemo<RcaReport | null>(() => {
    const raw = data?.investigation.report;
    if (!raw) return null;
    try { return JSON.parse(raw) as RcaReport; } catch { return null; }
  }, [data?.investigation.report]);

  const running = !!run?.running;
  const parked = !!run?.parked && running;
  const interrupted = !!run?.hydrated && running && !parked;
  const liveRunning = running && !interrupted && !parked;

  // Live elapsed ticker while truly live (mirrors InlineRunRegion).
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!liveRunning) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [liveRunning, run?.kind, investigationId]);

  const finalSeconds =
    run?.kind === "orchestrator" && run.orchStats ? run.orchStats.durationMs / 1000
    : run?.kind === "deep-mode" && run.deepStats ? run.deepStats.durationMs / 1000
    : undefined;
  const elapsedLabel = liveRunning ? fmtSeconds(elapsed) : finalSeconds != null ? fmtSeconds(finalSeconds) : "";

  const pulse = parked ? "bg-warning"
    : interrupted ? "bg-muted-foreground/40"
    : running ? "bg-primary animate-[status-pulse_1.8s_ease-in-out_infinite]"
    : run?.error ? "bg-destructive"
    : run?.pause ? "bg-warning"
    : run ? "bg-success"
    : "bg-muted-foreground/30";

  const paused = !!run?.pause;
  const locked = !!run?.decisionSubmitted;
  const statusWord = !run ? "no run" : parked ? "parked" : interrupted ? "interrupted" : running ? "running" : "finished";

  return (
    <div className="h-full flex flex-col bg-card/30">
      {/* Scoped assertive live region — state changes + pause only (DZ4). */}
      {run && <div aria-live="assertive" className="sr-only">{liveAnnouncement(run)}</div>}

      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border/60 shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="font-mono text-[11px] px-2 py-1 rounded-md border border-border/60 text-muted-foreground hover:text-foreground/90 shrink-0"
          aria-label="Back to investigation"
        >← Back</button>
        <span className={`w-2 h-2 rounded-full shrink-0 ${pulse}`} aria-hidden />
        <h1 className="font-semibold text-[15px] text-foreground truncate">
          Deep Investigation{service ? <span className="text-muted-foreground/70"> · {service}</span> : null}
        </h1>
        {elapsedLabel && <span className="font-mono text-[11px] text-muted-foreground/55 shrink-0">{elapsedLabel}</span>}
        <span className="font-mono text-[10px] text-muted-foreground/45 shrink-0 ml-auto" aria-label={`status: ${statusWord}`}>{statusWord}</span>
        {liveRunning && run?.kind === "orchestrator" && (
          <button
            type="button"
            onClick={() => stop(investigationId)}
            aria-label="Stop the deep investigation"
            className="font-mono text-[10px] px-2.5 py-1 rounded-md border border-border/60 text-muted-foreground hover:text-destructive hover:border-destructive/40 shrink-0"
          >■ STOP</button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-5 py-4">
        {!run && notFound ? (
          <div className="text-[13px] text-muted-foreground">This investigation could not be found.</div>
        ) : !run && originalReport?.deepMode ? (
          // Cold reload of a completed Challenge (deep-mode) run: no DeepRunState is
          // hydrated (deep-mode results persist in report.deepMode, not as replayable
          // orchestrator events), so render the persisted revision directly (PR-5, D5).
          <div className="max-w-3xl">
            <div className="font-mono text-[9px] tracking-[0.13em] uppercase text-accent/70">Deep re-examination</div>
            <div className="font-semibold text-[14px] leading-snug mt-1 text-foreground">
              {(() => {
                const rev = computeRevision(undefined, originalReport);
                return rev.kind === "none"
                  ? "Deeper look complete — the original RCA stands"
                  : "Deeper look revised the original RCA";
              })()}
            </div>
            <RevisionDiff result={computeRevision(undefined, originalReport)} />
          </div>
        ) : !run ? (
          // Empty state — no deep run yet. Offer to start one in place (D7).
          <div className="max-w-xl">
            <div className="font-mono text-[9px] tracking-[0.13em] uppercase text-accent/70">Deep Investigation</div>
            <div className="font-semibold text-[15px] mt-1 text-foreground">No deep investigation yet</div>
            <p className="text-[13px] text-muted-foreground mt-2 mb-3 leading-snug">
              Start an autonomous deep investigation for this report. It runs server-side and streams here — it survives a reload and resumes if you step away.
            </p>
            <ScopedDeepMenu investigationId={investigationId} canChallenge={canChallenge} />
          </div>
        ) : (
          <div className="max-w-3xl flex flex-col gap-5">
            {/* Result-first dossier */}
            <section><ResultView run={run} providers={providers} originalReport={originalReport} /></section>

            {/* Move log */}
            <section className="border-t border-border/60 pt-4">
              <div className="font-mono text-[9px] tracking-[0.13em] uppercase text-muted-foreground/55 mb-2">Move log</div>
              <LiveView run={run} live={liveRunning} />
            </section>

            {parked && (
              <div className="flex gap-2 items-start rounded-md border border-warning/30 bg-warning/8 px-3 py-2">
                <span className="text-warning text-[12px] leading-none mt-0.5" aria-hidden>⏸</span>
                <span className="text-[12px] text-foreground/80 leading-snug">
                  This run parked itself while no one was watching, to save tokens. It resumes automatically now that you're back.
                </span>
              </div>
            )}
            {interrupted && (
              <div className="flex gap-2 items-start rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                <span className="text-muted-foreground text-[12px] leading-none mt-0.5" aria-hidden>⏸</span>
                <span className="text-[12px] text-foreground/80 leading-snug">
                  This run was interrupted and can't be resumed here. The steps above are what completed before it stopped — re-run to continue.
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Docked pause bar (decision routes through the registry — D7 cross-tab lock).
          Suppressed when parked/interrupted (no live loop to answer). */}
      {paused && !interrupted && !parked && (
        <OperatorPauseBar
          size="wide"
          strikes={run?.pause?.strikes}
          locked={locked}
          operatorContext={run?.operatorContext}
          onDecide={(decision, context) => decide(investigationId, decision, context)}
        />
      )}
    </div>
  );
}

/**
 * ScopedDeepMenu (PR-1, task T4) — the single "Investigate deeply" entry on the
 * RCA report. Replaces the old separate deep-mode + orchestrator buttons with one
 * scoped dropdown (the legacy buttons coexist in PR-1 per D9; the IA cleanup that
 * removes them is deferred to PR-2).
 *
 * Two scopes, routed through the run registry's `start`:
 *   • Challenge this RCA   → deep_mode_investigate   (cheap, seconds, result saved)
 *   • Full deep investigation → orchestrator_investigate (3–8min, $$$, ends on reload)
 *
 * Labels encode durability AND cost (DZ5). Full routes through a cancellable
 * confirm-dispatch countdown (DT2); Challenge launches immediately. Full is
 * disabled while the socket is reconnecting (D6/T6) and while a run is active.
 *
 * Gating mirrors the legacy buttons: Challenge needs `__DEEP_MODE_ENABLED__` and a
 * report with a `loopOutcome` to re-examine; Full needs `__ORCHESTRATOR_ENABLED__`.
 */
import { useEffect, useState } from "react";
import { Compass, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useOrchestratorRun, useOrchestratorRunActions } from "../contexts/OrchestratorRunContext";

const COUNTDOWN_FROM = 3;

export function ScopedDeepMenu({
  investigationId,
  canChallenge,
}: {
  investigationId: string;
  /** The report has a loop outcome — deep mode has ruled-out causes to re-judge. */
  canChallenge: boolean;
}) {
  const { start, connectionStatus } = useOrchestratorRunActions();
  const run = useOrchestratorRun(investigationId);
  // null = idle; a number = a Full run is in its confirm-dispatch countdown.
  const [countdown, setCountdown] = useState<number | null>(null);

  // Tick the countdown; at zero, dispatch the Full run.
  useEffect(() => {
    if (countdown === null) return;
    // A run started elsewhere (e.g. the coexisting legacy button) while we were
    // counting down — abort the countdown so we don't dispatch a duplicate that
    // the server rejects and the registry would apply to the live run.
    if (run?.running) {
      setCountdown(null);
      return;
    }
    if (countdown <= 0) {
      setCountdown(null);
      // The Full run streams in the Console (InlineRunRegion) — the single home
      // for a deep run (PR-6). No navigation; the operator stays on the report.
      start(investigationId, "full");
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 900);
    return () => clearTimeout(t);
  }, [countdown, investigationId, start, run?.running]);

  const deepEnabled = typeof window !== "undefined" && !!window.__DEEP_MODE_ENABLED__ && canChallenge;
  const fullEnabled = typeof window !== "undefined" && !!window.__ORCHESTRATOR_ENABLED__;
  if (!deepEnabled && !fullEnabled) return null;

  const running = !!run?.running;
  const offline = connectionStatus !== "connected";

  // Confirm-dispatch countdown (DT2) — replaces the trigger while counting down.
  if (countdown !== null) {
    return (
      <div
        className="flex items-center gap-2 h-9 px-3 rounded-lg border border-accent/40 bg-accent/8 font-mono text-[11px]"
        role="status"
        aria-live="polite"
      >
        <span className="text-accent/90">Starting Full Deep Investigation in {countdown}…</span>
        <span className="text-muted-foreground/60">~3–8min · $$$</span>
        <button
          type="button"
          onClick={() => setCountdown(null)}
          className="ml-1 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          aria-label="Cancel the deep investigation"
        >
          <X size={11} className="!size-auto" /> cancel
        </button>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={running}
          title="Run a deeper investigation — challenge the RCA, or hunt for the real cause"
          className="h-9 px-4 text-[12px] font-mono inline-flex items-center gap-1.5 rounded-lg border border-primary/30 text-primary/80 hover:bg-primary/8 hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Compass size={12} className="!size-auto" />
          {running ? "Investigating…" : "Investigate deeply"}
          <span className="text-[9px] opacity-60" aria-hidden>▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[300px]">
        {deepEnabled && (
          <DropdownMenuItem
            disabled={running}
            onClick={() => start(investigationId, "challenge")}
            className="flex flex-col items-start gap-0.5 py-2"
          >
            <span className="text-[12.5px] font-sans font-semibold text-foreground">Challenge this RCA</span>
            <span className="text-[11px] text-muted-foreground">Re-judge the ruled-out causes with deeper queries</span>
            <span className="flex gap-2 font-mono text-[9.5px] mt-0.5">
              <span className="text-success">~10–20s · $</span>
              <span className="text-muted-foreground/60">result saved</span>
            </span>
          </DropdownMenuItem>
        )}
        {fullEnabled && (
          <DropdownMenuItem
            disabled={running || offline}
            onClick={() => setCountdown(COUNTDOWN_FROM)}
            className="flex flex-col items-start gap-0.5 py-2"
          >
            <span className="text-[12.5px] font-sans font-semibold text-foreground">Full deep investigation</span>
            <span className="text-[11px] text-muted-foreground">
              {offline ? "Unavailable while reconnecting" : "Autonomous hunt for the real cause across dependencies"}
            </span>
            <span className="flex gap-2 font-mono text-[9.5px] mt-0.5">
              <span className="text-warning">~3–8min · $$$</span>
              <span className="text-warning/80">ends if you leave</span>
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

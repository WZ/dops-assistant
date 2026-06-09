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
 * Gating mirrors the legacy buttons: Challenge needs `__CHALLENGE__` and a
 * report with a `loopOutcome` to re-examine; Full needs `__AUTONOMOUS__`.
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
  // Follow a lead: the optional hunch box. Progressive disclosure — collapsed until
  // the operator clicks "+ add a lead", so the blind-Full path is never interrupted.
  // An empty lead dispatches exactly today's blind Full run.
  const [leadOpen, setLeadOpen] = useState(false);
  const [lead, setLead] = useState("");

  // Tick the countdown; at zero, dispatch the Full run (seeded if a lead was typed).
  useEffect(() => {
    if (countdown === null) return;
    // A live run started elsewhere while we were counting down — abort so we
    // don't dispatch a duplicate the server rejects. A hydrated (interrupted) run
    // reports running=true but is dead server-side, so it does NOT block a launch.
    if (run?.running && !run.hydrated) {
      setCountdown(null);
      return;
    }
    if (countdown <= 0) {
      setCountdown(null);
      // The Full run streams in the Console (InlineRunRegion) — the single home
      // for a deep run (PR-6). No navigation; the operator stays on the report.
      // `lead` is "" for a direct Full click → a blind hunt.
      start(investigationId, "full", lead);
      setLead("");
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 900);
    return () => clearTimeout(t);
  }, [countdown, investigationId, start, run?.running, lead]);

  const deepEnabled = typeof window !== "undefined" && !!window.__CHALLENGE__ && canChallenge;
  const fullEnabled = typeof window !== "undefined" && !!window.__AUTONOMOUS__;
  if (!deepEnabled && !fullEnabled) return null;

  // A hydrated (interrupted) run reports running=true but is dead server-side —
  // it must not lock the launch button, or the operator can't re-run after a
  // server restart. Only a genuinely live (or parked, resumable) run blocks.
  const running = !!run?.running && !run?.hydrated;
  const offline = connectionStatus !== "connected";

  // Confirm-dispatch countdown (DT2) — replaces the trigger while counting down.
  if (countdown !== null) {
    return (
      <div
        className="inline-flex items-center gap-2 py-1 px-2.5 rounded-full border border-accent/40 bg-accent/8 font-mono text-[10px]"
        role="status"
        aria-live="polite"
      >
        <span className="text-accent/90">Starting deep investigation in {countdown}…</span>
        <span className="text-muted-foreground/60">{lead.trim() ? "~1–4min · $$" : "~3–8min · $$$"}</span>
        <button
          type="button"
          onClick={() => setCountdown(null)}
          className="ml-0.5 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          aria-label="Cancel the deep investigation"
        >
          <X size={10} className="!size-auto" /> cancel
        </button>
      </div>
    );
  }

  // Lead-input mode (Follow a lead) — replaces the trigger, like the countdown.
  // The textarea lives OUTSIDE the Radix menu (menus don't host text inputs well):
  // clicking "+ add a lead" closes the menu and opens this, then Go starts the
  // (seeded) countdown.
  if (leadOpen) {
    return (
      <div
        className="inline-flex flex-col gap-1.5 py-2 px-2.5 rounded-lg border border-primary/40 bg-primary/[0.06] w-[300px]"
        role="group"
        aria-label="Add a lead, then start the deep investigation"
      >
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-primary/70">Follow a lead — your hunch seeds the run</span>
        <textarea
          autoFocus
          value={lead}
          onChange={(e) => setLead(e.target.value)}
          rows={2}
          aria-label="Lead to seed the deep investigation"
          placeholder="e.g. check the connection pool — or: started right after the 14:00 deploy"
          className="w-full rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-[11.5px] font-sans resize-y focus:outline-none focus:border-primary/50"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={offline}
            onClick={() => { setLeadOpen(false); setCountdown(COUNTDOWN_FROM); }}
            className="font-mono text-[10px] px-3 py-1 rounded-md border border-primary/50 bg-primary/10 text-primary hover:bg-primary/15 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ▸ Go
          </button>
          <span className="font-mono text-[9.5px] text-warning/80">{lead.trim() ? "~1–4min · $$ · warm start" : "~3–8min · $$$ · blind hunt"}</span>
          <button
            type="button"
            onClick={() => { setLeadOpen(false); setLead(""); }}
            className="ml-auto font-mono text-[9.5px] inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            aria-label="Cancel"
          >
            <X size={10} className="!size-auto" /> cancel
          </button>
        </div>
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
          className="px-2.5 py-1 text-[10px] font-mono inline-flex items-center gap-1.5 rounded-full border border-primary/40 text-primary/80 hover:bg-primary/8 hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Compass size={11} className="!size-auto" />
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
          <>
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
            {/* Follow a lead — opt-in refinement. Collapsed link; clicking it closes
                the menu and opens the lead-input pill. Clicking Full above just runs
                a blind hunt as before, so this never interrupts the no-lead path. */}
            <DropdownMenuItem
              disabled={running}
              onClick={() => setLeadOpen(true)}
              className="flex items-center gap-1.5 py-1.5 -mt-0.5"
            >
              <span className="font-mono text-[10px] text-primary/85">+ add a lead</span>
              <span className="font-mono text-[9.5px] text-muted-foreground/55">optional — start from a hunch</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

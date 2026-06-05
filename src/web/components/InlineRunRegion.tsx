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
import { AgentStream, type AgentStreamFooterItem } from "./AgentStream";
import { DeepModeStream } from "./DeepModeStream";
import {
  useOrchestratorRun,
  useOrchestratorRunActions,
  type DeepRunState,
} from "../contexts/OrchestratorRunContext";

/** Compact mm:ss / ss formatting for elapsed/duration. */
function fmtSeconds(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  return s >= 60 ? `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`;
}

function outcomeHeadline(outcome: string | undefined): string {
  switch (outcome) {
    case "confirmed": return "Confirmed a root cause";
    case "operator-pause": return "Paused — needs a human call";
    case "aborted": return "Stopped — run cancelled";
    case "budget-exhausted": return "Stopped — hit the token budget";
    case "tool-cap": return "Stopped — hit the query limit";
    case "wall-clock": return "Stopped — hit the time limit";
    case "exhausted": return "Stopped — no further moves";
    case "inconclusive": return "Inconclusive — no clear cause";
    default: return "Deep investigation finished";
  }
}

function kicker(run: DeepRunState): string {
  if (run.kind === "deep-mode") return "Deep re-examination";
  if (run.running) return "Working theory";
  return run.outcome === "confirmed" ? "Current conclusion" : "Result";
}

/** The one-line conclusion shown result-first, derived from the real run state. */
function conclusionHeadline(run: DeepRunState): string {
  if (run.kind === "deep-mode") {
    if (run.running) return "Re-judging the ruled-out causes…";
    const s = run.deepStats;
    if (s) return s.resurrected > 0
      ? `${s.resurrected} ruled-out cause${s.resurrected === 1 ? "" : "s"} resurrected on closer look`
      : "No ruled-out cause held up — the original RCA stands";
    return "Deep re-examination complete";
  }
  // orchestrator
  if (run.running) {
    const last = run.steps[run.steps.length - 1];
    return last?.target ? `Investigating: ${last.target}` : "Investigating the root cause…";
  }
  const root = run.causalChain?.find((l) => l.kind === "root-cause");
  if (run.outcome === "confirmed" && root) return root.label.replace(/^root cause:\s*/i, "");
  return outcomeHeadline(run.outcome);
}

/** Announce only state changes + the pause prompt (DZ4) — empty while a run
 *  streams mid-flight, so the move log never reaches the live region. */
function liveAnnouncement(run: DeepRunState): string {
  if (run.pause && !run.decisionSubmitted) return `Paused after ${run.pause.strikes} strikes — your decision is needed.`;
  if (!run.running && run.error) return `Deep investigation stopped: ${run.error}`;
  if (!run.running && run.outcome) return `Deep investigation finished: ${outcomeHeadline(run.outcome)}.`;
  if (run.running && run.steps.length === 0) return "Deep investigation started.";
  return "";
}

function CausalChain({ chain }: { chain: NonNullable<DeepRunState["causalChain"]> }) {
  return (
    <div className="mt-2.5 flex flex-col font-mono text-[11px]">
      {chain.map((link, i) => (
        <div key={i} className="flex flex-col">
          {i > 0 && <span className="text-muted-foreground/40 leading-none my-0.5" aria-hidden>↓</span>}
          <span className={link.kind === "root-cause" ? "text-success" : "text-foreground/90"}>{link.label}</span>
          {link.evidence && <span className="text-[10px] text-muted-foreground/70 leading-snug pl-3">{link.evidence}</span>}
        </div>
      ))}
    </div>
  );
}

/** Result-first view (default): conclusion → causal chain → trace summary. The
 *  move log is hidden here (switch to Live log for it) — DZ1/DZ2. */
function ResultView({ run }: { run: DeepRunState }) {
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.13em] uppercase text-accent/70">{kicker(run)}</div>
      <div className="font-semibold text-[14px] leading-snug mt-1 text-foreground">{conclusionHeadline(run)}</div>
      {run.causalChain && run.causalChain.length > 1 && <CausalChain chain={run.causalChain} />}
      {run.traceSummary && <div className="font-mono text-[10px] text-muted-foreground/60 mt-2">{run.traceSummary}</div>}
      {run.steps.length > 0 && (
        <div className="mt-2 font-mono text-[10px] text-muted-foreground/45">
          {run.steps.length} move{run.steps.length === 1 ? "" : "s"} · switch to Live log for detail
        </div>
      )}
    </div>
  );
}

/** The raw move stream — reuses the same renderers as the legacy surfaces. */
function LiveView({ run }: { run: DeepRunState }) {
  if (run.kind === "deep-mode") {
    return <DeepModeStream events={run.steps} stats={run.deepStats} running={run.running} />;
  }
  const s = run.orchStats;
  const footer: AgentStreamFooterItem[] | undefined = s
    ? [
        { label: "moves", value: s.moves },
        { label: "queries", value: s.toolCalls },
        ...(s.subagents > 0 ? [{ label: "subagents", value: s.subagents }] : []),
        { label: "strikes", value: s.strikes, tone: s.strikes > 0 ? "warn" : "default" },
        { label: "tokens", value: s.tokensSpent },
      ]
    : undefined;
  return <AgentStream label="Deep Investigation" events={run.steps} footer={footer} running={run.running} />;
}

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
  // durationMs on completion). Resets when a new run starts.
  const [elapsed, setElapsed] = useState(0);
  const running = !!run?.running;
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [running, run?.kind, investigationId]);

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
  const elapsedLabel = run.running ? fmtSeconds(elapsed) : finalSeconds != null ? fmtSeconds(finalSeconds) : "";

  const pulse = run.running ? "bg-primary animate-[status-pulse_1.8s_ease-in-out_infinite]"
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
          aria-label={`${title} — ${run.running ? "running" : "finished"}. Click to ${collapsed ? "expand" : "collapse"}.`}
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

        {run.running && (
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
          {view === "result" ? <ResultView run={run} /> : <LiveView run={run} />}
        </div>
      )}

      {/* Ephemerality notice — a Full (orchestrator) run dies on reload in PR-1 (D6).
          T6 adds disabling the launch during reconnect. */}
      {!collapsed && run.kind === "orchestrator" && run.running && (
        <div className="mx-3 mb-2 flex gap-2 items-start rounded-md border border-warning/30 bg-warning/8 px-2.5 py-1.5">
          <span className="text-warning text-[11px] leading-none mt-0.5" aria-hidden>⚠</span>
          <span className="text-[10.5px] text-foreground/80 leading-snug">
            This run stops if you reload or close the tab. Durable, reload-safe runs ship in a later update.
          </span>
        </div>
      )}

      {/* Docked pause bar — pinned, shown even when collapsed so a pause is never
          hidden (DZ2/DZ8). Decision routes through the registry (D7 locking). */}
      {paused && (
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

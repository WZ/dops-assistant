import { AgentStream, type AgentStreamFooterItem, type AgentStreamBanner } from "./AgentStream.js";
import type { AgentStreamEvent, OrchestratorStreamStats, CausalChainLink } from "../../types/ws-types.js";

/**
 * Autonomous orchestrator (Approach D) stream — the same AgentStream rendering
 * as deep mode, with the orchestrator's footer (moves / queries / subagents /
 * depth / strikes / tokens / elapsed), a terminal outcome banner, the causal
 * chain (with source attribution), a one-line trace summary, and the
 * interactive operator-pause card (continue / escalate / instrument-&-wait)
 * shown when the loop hits its strike limit and is awaiting a human call.
 */

/** Operator's pending decision at a strike-limit pause (increment 5). */
export type OrchestratorPause = { strikes: number; hypothesesTried?: string[] };
/** The disposition the operator chose at a pause, once stopped (escalate/wait). */
export type OrchestratorDisposition = "escalate" | "wait";

function outcomeBanner(outcome: string | undefined, disposition?: OrchestratorDisposition): AgentStreamBanner | undefined {
  // An explicit operator decision overrides the generic pause copy so the
  // banner reflects what the human actually chose. Neither escalate nor wait
  // has a backend in v1 (no on-call page / scheduler) — they record intent.
  if (outcome === "operator-pause" && disposition === "escalate") {
    return { text: "Escalated to on-call. (Recorded only — no paging integration yet.)", tone: "warn" };
  }
  if (outcome === "operator-pause" && disposition === "wait") {
    return { text: "Marked to instrument & revisit. (Recorded only — no scheduler yet.)", tone: "muted" };
  }
  switch (outcome) {
    case "confirmed":
      return { text: "Confirmed a root cause — see the conclusion above.", tone: "good" };
    case "operator-pause":
      return {
        text: "Paused — ruled out every hypothesis it tried without finding the cause. The signal is ambiguous; this one needs a human call.",
        tone: "warn",
      };
    case "budget-exhausted":
      return { text: "Stopped — hit the token budget before confirming a cause.", tone: "warn" };
    case "tool-cap":
      return { text: "Stopped — hit the query limit before confirming a cause.", tone: "warn" };
    case "wall-clock":
      return { text: "Stopped — hit the time limit before confirming a cause.", tone: "warn" };
    case "exhausted":
      return { text: "Stopped — the agent ran out of moves without confirming a cause.", tone: "muted" };
    case "inconclusive":
      return { text: "Stopped — no further progress; inconclusive.", tone: "muted" };
    case "aborted":
      return { text: "Stopped — the run was cancelled.", tone: "muted" };
    default:
      return undefined;
  }
}

/** The strike-limit pause card: three explicit dispositions, no silent guess. */
function OperatorPauseCard({ pause, onDecision }: { pause: OrchestratorPause; onDecision: (d: "continue" | OrchestratorDisposition) => void }) {
  return (
    <div className="mt-1 rounded-lg border border-warning/30 bg-warning/[0.07] px-4 py-3.5 animate-fade-up">
      <div className="flex items-center gap-2 font-display font-bold text-[14px] text-warning mb-1">
        <span aria-hidden>⚠</span>
        Paused — {pause.strikes} {pause.strikes === 1 ? "hypothesis" : "hypotheses"} failed
      </div>
      <p className="text-[12.5px] text-foreground/80 leading-relaxed mb-2.5">
        The signal is ambiguous: every candidate cause tested was ruled out, and no discriminating evidence emerged.
        Rather than guess, the orchestrator stops and asks you.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onDecision("continue")}
          className="h-[30px] inline-flex items-center px-3 rounded-md border border-success/40 text-success text-[11px] font-mono hover:bg-success/10 transition-colors"
        >
          ▸ continue
        </button>
        <button
          type="button"
          onClick={() => onDecision("escalate")}
          className="h-[30px] inline-flex items-center px-3 rounded-md border border-destructive/40 text-destructive text-[11px] font-mono hover:bg-destructive/10 transition-colors"
        >
          ▸ escalate to on-call
        </button>
        <button
          type="button"
          onClick={() => onDecision("wait")}
          className="h-[30px] inline-flex items-center px-3 rounded-md border border-border text-muted-foreground text-[11px] font-mono hover:bg-muted/40 transition-colors"
        >
          ▸ instrument &amp; wait
        </button>
      </div>
    </div>
  );
}

export function OrchestratorStream({
  events,
  stats,
  outcome,
  causalChain,
  traceSummary,
  running,
  pause,
  disposition,
  onDecision,
}: {
  events: AgentStreamEvent[];
  stats?: OrchestratorStreamStats;
  outcome?: string;
  causalChain?: CausalChainLink[];
  traceSummary?: string;
  running: boolean;
  /** Set while a run is blocked at the strike limit awaiting an operator call. */
  pause?: OrchestratorPause | null;
  /** The disposition chosen at the last pause (escalate/wait), for the banner. */
  disposition?: OrchestratorDisposition;
  onDecision?: (decision: "continue" | OrchestratorDisposition) => void;
}) {
  const footer: AgentStreamFooterItem[] | undefined = stats
    ? [
        { label: "moves", value: stats.moves },
        { label: "queries", value: stats.toolCalls },
        ...(stats.subagents > 0 ? [{ label: "subagents", value: stats.subagents }] : []),
        { label: "depth", value: stats.depth },
        { label: "strikes", value: stats.strikes, tone: stats.strikes > 0 ? "warn" : "default" },
        { label: "tokens", value: stats.tokensSpent },
        { label: "took", value: `${(stats.durationMs / 1000).toFixed(1)}s` },
      ]
    : undefined;
  return (
    <>
      <AgentStream
        label="Autonomous Orchestrator"
        events={events}
        footer={footer}
        banner={outcomeBanner(outcome, disposition)}
        running={running}
      />
      {running && pause && onDecision && <OperatorPauseCard pause={pause} onDecision={onDecision} />}
      {!running && causalChain && causalChain.length > 1 && (
        <div className="mt-1 rounded-lg border border-border/60 bg-card px-4 py-3 animate-fade-up">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-accent/70 mb-2">Causal chain</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-[12px]">
            {causalChain.map((link, i) => (
              <span key={i} className="flex items-center gap-2">
                <span className="flex flex-col">
                  <span className={link.kind === "root-cause" ? "text-success" : "text-foreground/90"}>{link.label}</span>
                  {link.evidence && (
                    <span className="text-[10px] text-muted-foreground/70 leading-tight">{link.evidence}</span>
                  )}
                </span>
                {i < causalChain.length - 1 && <span className="text-muted-foreground/50">→</span>}
              </span>
            ))}
          </div>
        </div>
      )}
      {!running && traceSummary && (
        <div className="mt-1 px-1 font-mono text-[10px] text-muted-foreground/60">{traceSummary}</div>
      )}
    </>
  );
}

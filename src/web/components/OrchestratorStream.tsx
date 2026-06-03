import { AgentStream, type AgentStreamFooterItem, type AgentStreamBanner } from "./AgentStream.js";
import type { AgentStreamEvent, OrchestratorStreamStats } from "../../types/ws-types.js";

/**
 * Autonomous orchestrator (Approach D) stream — the same AgentStream rendering
 * as deep mode, with the orchestrator's footer (moves / queries / subagents /
 * depth / strikes / tokens / elapsed) and a terminal outcome banner so a run
 * never just stops ambiguously. The interactive operator-pause card (continue /
 * escalate / instrument-&-wait) lands in a later increment; this banner is the
 * minimum: tell the operator what happened.
 */
function outcomeBanner(outcome: string | undefined): AgentStreamBanner | undefined {
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
    default:
      return undefined;
  }
}

export function OrchestratorStream({
  events,
  stats,
  outcome,
  causalChain,
  running,
}: {
  events: AgentStreamEvent[];
  stats?: OrchestratorStreamStats;
  outcome?: string;
  causalChain?: string[];
  running: boolean;
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
        banner={outcomeBanner(outcome)}
        running={running}
      />
      {!running && causalChain && causalChain.length > 1 && (
        <div className="mt-1 rounded-lg border border-border/60 bg-card px-4 py-3 animate-fade-up">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-accent/70 mb-2">Causal chain</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[12px]">
            {causalChain.map((link, i) => (
              <span key={i} className="flex items-center gap-2">
                <span className={link.startsWith("root cause:") ? "text-success" : "text-foreground/90"}>{link}</span>
                {i < causalChain.length - 1 && <span className="text-muted-foreground/50">→</span>}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

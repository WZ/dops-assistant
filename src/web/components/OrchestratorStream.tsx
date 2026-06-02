import { AgentStream, type AgentStreamFooterItem } from "./AgentStream.js";
import type { AgentStreamEvent, OrchestratorStreamStats } from "../../types/ws-types.js";

/**
 * Autonomous orchestrator (Approach D) stream — the same AgentStream rendering
 * as deep mode, with the orchestrator's footer: moves, queries, depth, strikes,
 * tokens, elapsed. Strikes turn amber once any hypothesis has failed.
 */
export function OrchestratorStream({
  events,
  stats,
  running,
}: {
  events: AgentStreamEvent[];
  stats?: OrchestratorStreamStats;
  running: boolean;
}) {
  const footer: AgentStreamFooterItem[] | undefined = stats
    ? [
        { label: "moves", value: stats.moves },
        { label: "queries", value: stats.toolCalls },
        { label: "depth", value: stats.depth },
        { label: "strikes", value: stats.strikes, tone: stats.strikes > 0 ? "warn" : "default" },
        { label: "tokens", value: stats.tokensSpent },
        { label: "took", value: `${(stats.durationMs / 1000).toFixed(1)}s` },
      ]
    : undefined;
  return <AgentStream label="Autonomous Orchestrator" events={events} footer={footer} running={running} />;
}

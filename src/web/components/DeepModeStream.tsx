import { AgentStream, type AgentStreamFooterItem } from "./AgentStream.js";
import type { AgentStreamEvent, AgentStreamStats } from "../../types/ws-types.js";

/**
 * Deep mode (Step 3) stream — a thin wrapper over the shared AgentStream that
 * supplies the deep-mode label and footer. Rendering lives in AgentStream so the
 * orchestrator reuses the exact same look.
 */
export function DeepModeStream({
  events,
  stats,
  running,
  startedAt,
  inline = false,
}: {
  events: AgentStreamEvent[];
  stats?: AgentStreamStats;
  running: boolean;
  /** Run start (epoch ms) so the live timer survives a remount. */
  startedAt?: number;
  /** Bandless Console rendering (see AgentStream). */
  inline?: boolean;
}) {
  const footer: AgentStreamFooterItem[] | undefined = stats
    ? [
        { label: "re-checked", value: stats.examined },
        { label: "checks", value: stats.toolCalls },
        ...(stats.resurrected > 0 ? [{ label: "brought back", value: stats.resurrected, tone: "warn" as const }] : []),
        ...(stats.shaken > 0 ? [{ label: "weakened", value: stats.shaken, tone: "warn" as const }] : []),
        { label: "took", value: `${(stats.durationMs / 1000).toFixed(1)}s` },
      ]
    : undefined;
  return <AgentStream label="Deep Mode · second look" events={events} footer={footer} running={running} startedAt={startedAt} inline={inline} />;
}

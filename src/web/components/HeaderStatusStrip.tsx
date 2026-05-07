import { ScanActivityBadge } from "./ScanActivityBadge";
import type { StackSummary } from "../../types/stack-types.js";
import type { HealthPollingResult } from "./dashboard/useHealthPolling";

export interface HeaderStatusStripProps {
  activeStack: StackSummary | undefined;
  health: HealthPollingResult;
  onScanClick: () => void;
}

interface DerivedStatus {
  overall: "healthy" | "degraded" | "unreachable" | "unknown";
  mcpOk: boolean | null; // null when no providers configured
  dbOk: boolean | null;
}

/** Compute the strip's overall + per-component status from active-stack and server health.
 *
 *  MCP follows the active stack's `providerHealth` (added in PR #184). DB and version
 *  come from `/api/health`, which is now server-level only — MCP probing was removed
 *  in the health-monitor cleanup since it was load-bearing for nothing useful and
 *  previously caused a 503 outage. When the active stack hasn't reported yet we show
 *  `mcp:—` (unknown) rather than guessing from another stack.
 *
 *  Exported for unit tests.
 */
export function deriveStatus(
  activeStack: StackSummary | undefined,
  health: HealthPollingResult,
): DerivedStatus {
  if (health.connectionState === "unreachable") {
    return { overall: "unreachable", mcpOk: null, dbOk: null };
  }
  if (health.connectionState === "unknown") {
    return { overall: "unknown", mcpOk: null, dbOk: null };
  }
  if (!health.health) {
    return { overall: "unknown", mcpOk: null, dbOk: null };
  }

  const dbOk = health.health.probes.db.status === "ok";

  const ph = activeStack?.providerHealth;
  let mcpOk: boolean | null;
  if (ph) {
    // No providers configured → not an error, but not "ok" either.
    mcpOk = ph.total === 0 ? null : ph.ok > 0;
  } else {
    // Stack hasn't reported per-stack data yet (just-created or list still
    // loading). Show the indicator as "unknown" rather than guessing from a
    // global probe — `/api/health` no longer carries MCP state, and inferring
    // it from another stack would lie about the active one.
    mcpOk = null;
  }

  const mcpDegraded = mcpOk === false;
  const overall = !dbOk || mcpDegraded ? "degraded" : "healthy";
  return { overall, mcpOk, dbOk };
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

const DOT_CLASS: Record<DerivedStatus["overall"], string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  unreachable: "bg-destructive",
  unknown: "bg-muted-foreground/30",
};

const LABEL: Record<DerivedStatus["overall"], string> = {
  healthy: "HEALTHY",
  degraded: "DEGRADED",
  unreachable: "UNREACHABLE",
  unknown: "UNKNOWN",
};

function probeText(prefix: "mcp" | "db", ok: boolean | null): string {
  if (ok === null || ok === false) return `${prefix}:—`;
  return `${prefix}:ok`;
}

export function HeaderStatusStrip({ activeStack, health, onScanClick }: HeaderStatusStripProps) {
  const status = deriveStatus(activeStack, health);

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary/30">
      <div className={`w-1.5 h-1.5 rounded-full transition-colors ${DOT_CLASS[status.overall]}`} />
      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/75">
        {LABEL[status.overall]}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/75">
        {health.health ? formatUptime(health.health.uptime) : "—"}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/75">
        {probeText("mcp", status.mcpOk)}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/75">
        {probeText("db", status.dbOk)}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/75">
        {health.health?.version ? `v${health.health.version}` : "v—"}
      </span>
      <ScanActivityBadge onNavigate={onScanClick} />
    </div>
  );
}

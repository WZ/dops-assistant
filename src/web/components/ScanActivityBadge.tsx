// src/web/components/ScanActivityBadge.tsx
import { useScanActivity, type ScanActivity } from "../hooks/useScanActivity.js";

/**
 * ScanActivityBadge — 9px uppercase mono pill that lives inside the top-bar
 * health cluster. Gives operators at-a-glance confidence the scan is alive
 * without navigating to Settings.
 *
 * States (label → color):
 *   SCAN:OFF        → muted gray     — feature disabled
 *   SCAN:ERR        → destructive    — last tick raised an error
 *   SCAN:N⚠         → warning        — ran with overflow drops (cap too low)
 *   SCAN:N          → warning-tinted — N anomalies investigated in the window
 *   SCAN:0          → muted-success  — enabled + ticked + nothing tripped
 *   SCAN:ON         → muted gray     — enabled but not yet ticked
 *
 * Click navigates to /settings/scan via onNavigate — parent owns routing.
 */
interface Props {
  onNavigate: () => void;
}

export function pickState(activity: ScanActivity | null): {
  label: string;
  tone: "muted" | "success" | "warning" | "destructive";
  title: string;
} {
  if (!activity) {
    return { label: "SCAN:\u2014", tone: "muted", title: "Scan status loading" };
  }
  if (!activity.enabled) {
    return {
      label: "SCAN:OFF",
      tone: "muted",
      title: "Proactive scan disabled. Click to enable in Settings \u2192 Scan.",
    };
  }
  if (activity.lastError) {
    return {
      label: "SCAN:ERR",
      tone: "destructive",
      title: `Last tick failed: ${activity.lastError}`,
    };
  }
  if (!activity.lastRun) {
    // Enabled, waiting for first tick. Tell the operator when.
    const next = activity.nextRun ? ` (next at ${formatHint(activity.nextRun)})` : "";
    return {
      label: "SCAN:ON",
      tone: "muted",
      title: `Enabled, no tick yet${next}`,
    };
  }
  const window = `in last ${activity.windowHours}h`;
  if (activity.recentAnomalies > 0) {
    const hasDrops = activity.dropsByConcurrency > 0;
    return {
      label: hasDrops ? `SCAN:${activity.recentAnomalies}\u26A0` : `SCAN:${activity.recentAnomalies}`,
      tone: "warning",
      title: `${activity.recentAnomalies} anomal${activity.recentAnomalies === 1 ? "y" : "ies"} investigated ${window}${
        hasDrops ? ` \u00b7 ${activity.dropsByConcurrency} dropped by per-tick cap` : ""
      } \u00b7 last ran ${formatHint(activity.lastRun)}`,
    };
  }
  return {
    label: "SCAN:0",
    tone: "success",
    title: `0 anomalies ${window} \u00b7 last ran ${formatHint(activity.lastRun)}`,
  };
}

/** Tooltip-friendly "2h ago" / "in 3h" style hint. Kept small — Intl.RelativeTimeFormat is overkill. */
function formatHint(iso: string): string {
  try {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return iso;
    const delta = ms - Date.now();
    const absMin = Math.abs(delta) / 60_000;
    const rel = absMin < 1 ? "<1m" : absMin < 60 ? `${Math.round(absMin)}m` : `${Math.round(absMin / 60)}h`;
    return delta > 0 ? `in ${rel}` : `${rel} ago`;
  } catch {
    return iso;
  }
}

const TONE_CLASS = {
  muted: "text-muted-foreground/75 hover:text-muted-foreground",
  success: "text-success/75 hover:text-success",
  warning: "text-warning hover:text-warning",
  destructive: "text-destructive hover:text-destructive/80",
} as const;

export function ScanActivityBadge({ onNavigate }: Props) {
  const { activity } = useScanActivity({ pollMs: 30_000 });
  const { label, tone, title } = pickState(activity);

  return (
    <button
      type="button"
      onClick={onNavigate}
      title={title}
      aria-label={title}
      className={`font-mono text-[9px] uppercase tracking-wider transition-colors ${TONE_CLASS[tone]}`}
      data-testid="scan-activity-badge"
    >
      {label}
    </button>
  );
}

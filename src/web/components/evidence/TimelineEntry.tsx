import { useState, useCallback } from "react";
import { ExternalLink, Copy, Check } from "lucide-react";
import type { EvidenceAction } from "../../../types/evidence.js";

export interface TimelineEntryData {
  id: string;
  type: "log" | "infra";
  timestamp: string;
  timestampEnd?: string;
  /** True when the timestamp is an approximation (e.g. investigation window start)
   *  rather than a real per-observation time. Rendered with a `~` prefix. */
  isApproximate?: boolean;
  entity: string;
  summary: string;
  count?: number;
  severity?: string;
  expandedContent?: string;
  actions?: EvidenceAction[];
  phaseAction?: EvidenceAction;
}

// Render in the viewer's local timezone so "09:52:15" is unambiguous.
// The full ISO string goes into a title attribute for hover confirmation.
function formatTime(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

// Short local timezone abbreviation for the column header (e.g. "PDT", "EST", "UTC").
// Falls back to GMT offset if the browser doesn't expose an abbreviation.
function localTzAbbrev(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date());
    const tz = parts.find((p) => p.type === "timeZoneName")?.value;
    if (tz) return tz;
  } catch { /* ignore */ }
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const h = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const m = String(Math.abs(offset) % 60).padStart(2, "0");
  return `GMT${sign}${h}:${m}`;
}

const LOCAL_TZ = localTzAbbrev();

export function TimelineEntry({ entry }: { entry: TimelineEntryData }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const dotColor = entry.type === "log" ? "bg-warning" : "bg-destructive";
  const badgeBg =
    entry.type === "log"
      ? "bg-warning/10 text-warning border-warning/20"
      : "bg-destructive/10 text-destructive border-destructive/20";
  const badgeLabel = entry.type === "log" ? "LOG" : "INFRA";

  // Show a skeleton placeholder when no timestamp was available so the timeline
  // column stays visible (vs. a lone em-dash that disappears in dark mode).
  // Approximate timestamps (fall-backs to the investigation window start) are
  // prefixed with "~" so users know the time isn't precise.
  const start = formatTime(entry.timestamp);
  const end = entry.timestampEnd ? formatTime(entry.timestampEnd) : "";
  const hasTime = !!start || !!end;
  const prefix = entry.isApproximate && hasTime ? "~" : "";
  const timeCore =
    start && end ? `${prefix}${start} – ${end}` :
    start ? `${prefix}${start}` :
    end ? `${prefix}${end}` :
    "--:--:--";
  const timeDisplay = hasTime ? `${timeCore} ${LOCAL_TZ}` : timeCore;
  // Tooltip: show the raw ISO so users can see the exact timestamp + source timezone.
  const timeTooltip = entry.isApproximate
    ? `Approximate — fell back to investigation window start (${entry.timestamp || "?"})`
    : entry.timestampEnd
      ? `${entry.timestamp || "?"} → ${entry.timestampEnd}`
      : entry.timestamp || "no timestamp available";

  // Use observation-level action if available, fall back to phase-level
  const primaryAction = entry.actions?.[0] ?? entry.phaseAction;
  const isPhaseOnly = !entry.actions?.length && !!entry.phaseAction;
  const hasActions = !!primaryAction;

  const handleCopy = useCallback(() => {
    // Copy the query from the action URL (extract from panes param) or the summary
    const text = entry.summary;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }, [entry.summary]);

  return (
    <div className="group relative pl-5" role="listitem" tabIndex={0}>
      <div className={`absolute left-0 top-[10px] w-[7px] h-[7px] rounded-full ${dotColor}`} />
      <div className="pb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`font-mono text-[10px] tabular-nums ${hasTime ? "text-muted-foreground/75" : "text-muted-foreground/35"}`}
            title={timeTooltip}
          >
            {timeDisplay}
          </span>
          <span
            className={`font-mono text-[9px] uppercase px-1.5 py-0 border rounded ${badgeBg}`}
            aria-label={`${entry.type === "log" ? "Log" : "Infrastructure"} entry`}
          >
            {badgeLabel}
          </span>
          <span className="font-mono text-[10px] text-primary/70 bg-primary/8 px-1.5 py-0.5 rounded">
            {entry.entity}
          </span>
          {entry.count != null && (
            <span className="font-mono text-[10px] text-muted-foreground/50">×{entry.count}</span>
          )}
        </div>
        <p className="font-mono text-[11px] text-foreground/80 mt-1 leading-relaxed">{entry.summary}</p>

        {/* Action bar: visible on hover/focus, always visible on touch */}
        {hasActions && (
          <div className="flex items-center gap-1.5 mt-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 touch-device:opacity-100 transition-opacity duration-150">
            <a
              href={primaryAction.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1 font-mono text-[9px] px-1.5 py-0.5 rounded bg-primary/8 hover:bg-primary/15 transition-colors ${
                isPhaseOnly ? "text-primary/40 hover:text-primary/60" : "text-primary/60 hover:text-primary"
              }`}
              aria-label={isPhaseOnly ? "Explore this phase in Grafana" : "Open in Grafana Explore"}
            >
              <ExternalLink size={10} />
              {isPhaseOnly ? "Explore phase" : "Grafana"}
            </a>
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1 font-mono text-[9px] text-primary/40 hover:text-primary/60 px-1.5 py-0.5 rounded bg-primary/8 hover:bg-primary/15 transition-colors"
              aria-label="Copy summary"
            >
              {copied ? <Check size={10} /> : <Copy size={10} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}

        {entry.expandedContent && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[9px] font-mono text-muted-foreground/50 hover:text-foreground/70 mt-1 transition-colors"
            aria-label={expanded ? "collapse" : "expand"}
            aria-expanded={expanded}
          >
            {expanded ? "▾ collapse" : "▸ expand"}
          </button>
        )}
        {expanded && entry.expandedContent && (
          <pre className="font-mono text-[11px] bg-background/60 rounded-md p-2.5 mt-2 border border-border/20 text-muted-foreground/60 overflow-x-auto whitespace-pre-wrap">
            {entry.expandedContent}
          </pre>
        )}
      </div>
    </div>
  );
}

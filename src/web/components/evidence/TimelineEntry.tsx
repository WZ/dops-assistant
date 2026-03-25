import { useState } from "react";

export interface TimelineEntryData {
  id: string;
  type: "log" | "infra";
  timestamp: string;
  timestampEnd?: string;
  entity: string;
  summary: string;
  count?: number;
  severity?: string;
  expandedContent?: string;
}

function formatTime(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

export function TimelineEntry({ entry }: { entry: TimelineEntryData }) {
  const [expanded, setExpanded] = useState(false);

  const dotColor = entry.type === "log" ? "bg-warning" : "bg-destructive";
  const badgeBg =
    entry.type === "log"
      ? "bg-warning/10 text-warning border-warning/20"
      : "bg-destructive/10 text-destructive border-destructive/20";
  const badgeLabel = entry.type === "log" ? "LOG" : "INFRA";

  const timeDisplay = entry.timestampEnd
    ? `${formatTime(entry.timestamp)} – ${formatTime(entry.timestampEnd)}`
    : formatTime(entry.timestamp);

  return (
    <div className="relative pl-5" role="listitem" tabIndex={0}>
      <div className={`absolute left-0 top-[10px] w-[7px] h-[7px] rounded-full ${dotColor}`} />
      <div className="pb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[10px] text-muted-foreground/50">{timeDisplay}</span>
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

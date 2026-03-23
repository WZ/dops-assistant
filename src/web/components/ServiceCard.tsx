import { memo, useEffect, useState } from "react";
import { timeAgo } from "@/lib/dashboard-utils";

function DotTimeline({ data }: { data: Array<{ status: string }> }) {
  if (data.length < 3) return <span className="text-[9px] font-mono text-muted-foreground/40">&mdash;</span>;

  const healthyCount = data.filter(d => d.status === "healthy").length;
  const downCount = data.filter(d => d.status === "down").length;

  return (
    <div
      className="flex gap-[1.5px] overflow-hidden"
      role="img"
      aria-label={`Health: ${healthyCount} of ${data.length} checks healthy${downCount > 0 ? `, ${downCount} down` : ""}`}
    >
      {data.map((d, i) => (
        <div
          key={i}
          className="rounded-[1px]"
          style={{
            flex: "1 1 0",
            minWidth: 2,
            maxWidth: 6,
            height: 8,
            background: d.status === "healthy"
              ? "var(--color-success)"
              : d.status === "down"
              ? "var(--color-destructive)"
              : "var(--color-muted-foreground)",
            opacity: d.status === "down" ? 0.7 : d.status === "healthy" ? 0.45 : 0.2,
          }}
        />
      ))}
    </div>
  );
}

interface ServiceCardProps {
  name: string;
  onClick: () => void;
  lastInvestigation?: {
    status: string; // "complete" | "failed" | "running"
    created_at: string;
  } | null;
  investigationCount?: number;
  healthStatus?: "healthy" | "degraded" | "down" | "unknown";
  /** Show hide button on hover — called when user clicks it */
  onHide?: () => void;
  /** Show unhide button (for hidden cards) */
  onUnhide?: () => void;
  /** Card is in the HIDDEN group */
  isHidden?: boolean;
  /** Show auto-hide suggestion badge */
  suggestHide?: boolean;
  /** Reason why service was hidden (shown in HIDDEN group) */
  hideReason?: string | null;
  /** Bulk selection mode — show checkbox */
  selectionMode?: boolean;
  /** Whether this card is selected in bulk mode */
  selected?: boolean;
  /** Toggle selection in bulk mode */
  onToggleSelect?: () => void;
}

export const ServiceCard = memo(function ServiceCard({
  name, onClick, lastInvestigation, investigationCount, healthStatus,
  onHide, onUnhide, isHidden, suggestHide, hideReason,
  selectionMode, selected, onToggleSelect,
}: ServiceCardProps) {
  const [historyData, setHistoryData] = useState<Array<{ status: string }>>([]);

  // Fetch sparkline history once on mount
  useEffect(() => {
    fetch(`/api/services/health/history?service=${encodeURIComponent(name)}&hours=24`)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        if (Array.isArray(data)) setHistoryData(data);
      })
      .catch(() => {/* ignore — sparkline is non-critical */});
  }, [name]);

  let dotClass: string;
  let healthLabel: string;

  switch (healthStatus) {
    case "healthy":
      dotClass = "w-2 h-2 rounded-full bg-success/80 ring-2 ring-success/15";
      healthLabel = "healthy";
      break;
    case "degraded":
      dotClass = "w-2 h-2 rounded-full bg-warning/80 ring-2 ring-warning/15";
      healthLabel = "degraded";
      break;
    case "down":
      dotClass = "w-2 h-2 rounded-full bg-destructive/80 ring-2 ring-destructive/15 animate-status-pulse";
      healthLabel = "down";
      break;
    default:
      dotClass = "w-2 h-2 rounded-full bg-muted-foreground/30";
      healthLabel = "\u2014";
      break;
  }

  const handleCardClick = () => {
    if (selectionMode) {
      onToggleSelect?.();
    } else {
      onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCardClick(); } }}
      className={`group w-full text-left rounded-lg border px-4 py-3 transition-all card-lift cursor-pointer relative ${
        isHidden
          ? "border-border/20 bg-card/30 opacity-50"
          : selected
          ? "border-primary/30 bg-card/70"
          : "border-border/40 bg-card/50 hover:bg-card/80 hover:border-primary/25"
      }`}
    >
      {/* Bulk selection checkbox */}
      {selectionMode && !isHidden && (
        <div className="absolute top-2 left-2">
          <div
            className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
              selected ? "bg-primary border-primary" : "border-muted-foreground/30"
            }`}
          >
            {selected && (
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className={dotClass}
            aria-label={`Service ${name}: status ${healthStatus ?? "unknown"}`}
          />
          <span className={`font-body text-sm font-medium transition-colors ${
            isHidden ? "text-foreground/50" : "text-foreground/75 group-hover:text-foreground/95"
          }`}>
            {name}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Hide button (hover-only for non-hidden cards) */}
          {onHide && !isHidden && !selectionMode && (
            <button
              onClick={(e) => { e.stopPropagation(); onHide(); }}
              className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 text-muted-foreground/30 hover:text-destructive/60 transition-all p-1 -mr-1"
              aria-label={`Hide service ${name}`}
              title="Hide from monitoring"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                <path d="m6.72 6.72 4.24 4.24"/>
                <path d="m14.12 14.12-1.07-1.07"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            </button>
          )}
          {/* Unhide button (for hidden cards) */}
          {onUnhide && isHidden && (
            <button
              onClick={(e) => { e.stopPropagation(); onUnhide(); }}
              className="text-primary/60 hover:text-primary transition-colors p-1 -mr-1"
              aria-label={`Unhide service ${name}`}
              title="Unhide — resume monitoring"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          )}
          {/* Investigate icon (non-hidden, non-selection) */}
          {!isHidden && !selectionMode && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground/15 group-hover:text-primary/50 transition-colors">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.3-4.3"/>
            </svg>
          )}
        </div>
      </div>
      <div className={`mt-1.5 ${selectionMode ? "pl-[18px]" : "pl-[18px]"}`}>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-[0.15em]">
            {healthLabel}
          </span>
          {/* Auto-hide suggestion badge */}
          {suggestHide && !isHidden && (
            <button
              onClick={(e) => { e.stopPropagation(); onHide?.(); }}
              className="text-[9px] font-mono text-warning/60 border border-warning/20 rounded px-1.5 py-0.5 hover:bg-warning/10 transition-colors"
              aria-label={`Suggest hiding ${name} — no monitoring data`}
            >
              hide?
            </button>
          )}
        </div>
        {/* Hide reason for hidden cards */}
        {isHidden && hideReason && (
          <p className="text-[9px] font-mono text-muted-foreground/40 mt-0.5 truncate" title={hideReason}>
            {hideReason}
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-1.5">
          <div className="flex-1 min-w-0">
            <DotTimeline data={historyData} />
          </div>
          <span className="text-[8px] font-mono text-muted-foreground/30 flex-shrink-0">24h</span>
        </div>
        {(investigationCount !== undefined && investigationCount > 0 || lastInvestigation) && (
          <div className="mt-1.5 flex items-center gap-2">
            {investigationCount !== undefined && investigationCount > 0 && (
              <span className="text-[9px] font-mono text-muted-foreground/40">
                {investigationCount} investigations
              </span>
            )}
            {lastInvestigation && (
              <span className="text-[9px] font-mono text-muted-foreground/40">
                {timeAgo(lastInvestigation.created_at)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

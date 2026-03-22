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
}

export const ServiceCard = memo(function ServiceCard({ name, onClick, lastInvestigation, investigationCount, healthStatus }: ServiceCardProps) {
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

  return (
    <button
      onClick={onClick}
      className="group w-full text-left rounded-lg border border-border/40 bg-card/50 hover:bg-card/80 hover:border-primary/25 px-4 py-3 transition-all card-lift"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className={dotClass}
            aria-label={`Service ${name}: status ${healthStatus ?? "unknown"}`}
          />
          <span className="font-body text-sm font-medium text-foreground/75 group-hover:text-foreground/95 transition-colors">
            {name}
          </span>
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground/15 group-hover:text-primary/50 transition-colors">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.3-4.3"/>
        </svg>
      </div>
      <div className="mt-1.5 pl-[18px]">
        <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-[0.15em]">
          {healthLabel}
        </span>
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
    </button>
  );
});

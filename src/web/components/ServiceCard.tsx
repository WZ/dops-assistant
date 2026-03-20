import { memo, useEffect, useState } from "react";
import { timeAgo } from "@/lib/dashboard-utils";

function Sparkline({ data }: { data: Array<{ status: string }> }) {
  if (data.length < 5) return <span className="text-[9px] font-mono text-muted-foreground/40">&mdash;</span>;

  const w = 60, h = 16;
  const step = w / (data.length - 1);

  // Map status to y value: healthy=top (2), unknown=mid (8), down=bottom (14)
  const points = data.map((d, i) => {
    const y = d.status === "healthy" ? 2 : d.status === "down" ? 14 : 8;
    return `${i * step},${y}`;
  }).join(" ");

  // Color: mostly healthy = success, mostly down = destructive, mixed = warning
  const downCount = data.filter(d => d.status === "down").length;
  const ratio = downCount / data.length;
  const color = ratio > 0.5 ? "var(--color-destructive)" : ratio > 0 ? "var(--color-warning)" : "var(--color-success)";

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Health trend: ${downCount} of ${data.length} checks down`}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
    </svg>
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
    fetch(`/api/services/health/history?service=${encodeURIComponent(name)}&hours=6`)
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
      <div className="mt-1.5 pl-[18px] flex items-center gap-2">
        <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-[0.15em]">
          {healthLabel}
        </span>
        <Sparkline data={historyData} />
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
    </button>
  );
});

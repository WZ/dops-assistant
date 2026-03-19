import { memo } from "react";
import { timeAgo } from "@/lib/dashboard-utils";

interface ServiceCardProps {
  name: string;
  onClick: () => void;
  lastInvestigation?: {
    status: string; // "complete" | "failed" | "running"
    created_at: string;
  } | null;
  investigationCount?: number;
}

export const ServiceCard = memo(function ServiceCard({ name, onClick, lastInvestigation, investigationCount }: ServiceCardProps) {
  let dotClass = "w-2 h-2 rounded-full bg-muted-foreground/30";
  let healthLabel = "unknown";

  if (lastInvestigation) {
    if (lastInvestigation.status === "complete") {
      dotClass = "w-2 h-2 rounded-full bg-success/80 ring-2 ring-success/15";
      healthLabel = "healthy";
    } else if (lastInvestigation.status === "failed") {
      dotClass = "w-2 h-2 rounded-full bg-destructive/80 ring-2 ring-destructive/15";
      healthLabel = "error";
    } else if (lastInvestigation.status === "running") {
      dotClass = "w-2 h-2 rounded-full bg-accent/80 animate-status-pulse";
      healthLabel = "investigating";
    }
  }

  return (
    <button
      onClick={onClick}
      className="group w-full text-left rounded-lg border border-border/40 bg-card/50 hover:bg-card/80 hover:border-primary/25 px-4 py-3 transition-all card-lift"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={dotClass} />
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

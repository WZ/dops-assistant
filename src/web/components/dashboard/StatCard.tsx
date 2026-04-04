import { memo, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: string;
  detail?: ReactNode;
  trend?: {
    direction: "up" | "down";
    value: string;
    positive: boolean;
  };
  variant?: "default" | "success" | "warning" | "danger";
  loading?: boolean;
}

export const StatCard = memo(function StatCard({
  label,
  value,
  detail,
  trend,
  variant = "default",
  loading = false,
}: StatCardProps) {
  const valueColor = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-destructive",
  }[variant];

  const accentBorder = {
    default: "border-l-primary/60",
    success: "border-l-success/70",
    warning: "border-l-warning/70",
    danger: "border-l-destructive/70",
  }[variant];

  if (loading) {
    return (
      <div
        role="group"
        aria-label={`${label}: loading`}
        className="rounded-lg border border-border/40 bg-card/50 p-4"
      >
        {/* Value skeleton */}
        <div className="h-8 w-3/5 rounded-md shimmer-skeleton" />
        {/* Label skeleton */}
        <div className="mt-2 h-2.5 w-2/5 rounded shimmer-skeleton" style={{ animationDelay: "0.1s" }} />
        {/* Detail skeleton */}
        <div className="mt-1.5 h-2 w-4/5 rounded shimmer-skeleton" style={{ animationDelay: "0.2s" }} />
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={`${label}: ${value}`}
      className={cn("rounded-lg border border-border/40 border-l-[3px] bg-card/50 p-4 card-lift noise relative overflow-hidden", accentBorder)}
    >
      {/* Value row — mono-display level */}
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-[36px] font-semibold tabular-nums leading-none tracking-tight",
            valueColor
          )}
        >
          {value}
        </span>

        {trend && (
          <span
            className={cn(
              "font-mono text-[11px] font-semibold tabular-nums",
              trend.positive ? "text-success" : "text-destructive"
            )}
            aria-label={`${trend.direction === "up" ? "up" : "down"} ${trend.value}`}
          >
            {trend.direction === "down" ? "▼" : "▲"}
            {trend.value}
          </span>
        )}
      </div>

      {/* Label — uppercase mono stamp */}
      <div className="mt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </div>

      {/* Detail — mono-xs */}
      {detail && (
        <div className="mt-1 font-mono text-[9px] text-muted-foreground/75 leading-snug">
          {detail}
        </div>
      )}
    </div>
  );
});

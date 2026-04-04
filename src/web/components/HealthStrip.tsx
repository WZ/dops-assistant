// src/web/components/HealthStrip.tsx
import { useMemo } from "react";

type HealthStatus = "healthy" | "degraded" | "down" | "unknown";

interface ServiceHealth {
  name: string;
  health: HealthStatus;
}

interface HealthStripProps {
  services: ServiceHealth[];
  onClickService: (name: string) => void;
  onViewAll: () => void;
}

const HEALTH_ORDER: Record<HealthStatus, number> = { down: 0, degraded: 1, unknown: 2, healthy: 3 };

const DOT_COLORS: Record<HealthStatus, string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/30",
};

const CHIP_TINTS: Record<HealthStatus, string> = {
  healthy: "bg-success/6 hover:bg-success/12 border border-success/10",
  degraded: "bg-warning/8 hover:bg-warning/15 border border-warning/12",
  down: "bg-destructive/8 hover:bg-destructive/15 border border-destructive/12",
  unknown: "bg-secondary/50 hover:bg-secondary border border-transparent",
};

export function HealthStrip({ services, onClickService, onViewAll }: HealthStripProps) {
  const sorted = useMemo(
    () => [...services].sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name)),
    [services],
  );

  if (sorted.length === 0) return null;

  return (
    <div data-testid="health-strip" className="flex flex-wrap gap-1.5 p-3 px-4 bg-card border border-border rounded-lg">
      {sorted.map((svc, i) => (
        <button
          key={svc.name}
          onClick={() => onClickService(svc.name)}
          className={`flex items-center gap-[5px] px-2.5 py-1 rounded-md transition-colors animate-fade-up ${CHIP_TINTS[svc.health] ?? CHIP_TINTS.unknown}`}
          style={{ animationDelay: `${Math.min(i * 0.04, 0.32)}s` }}
        >
          <span className={`w-[5px] h-[5px] rounded-full ${DOT_COLORS[svc.health]}`} />
          <span className="font-mono text-[10px] font-medium text-foreground/90">{svc.name}</span>
        </button>
      ))}
      <button
        onClick={onViewAll}
        className="flex items-center gap-1 px-2.5 py-1 font-mono text-[10px] text-primary/70 hover:text-primary transition-colors"
      >
        View all &rarr;
      </button>
    </div>
  );
}

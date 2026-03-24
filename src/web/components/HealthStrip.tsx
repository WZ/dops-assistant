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

export function HealthStrip({ services, onClickService, onViewAll }: HealthStripProps) {
  const sorted = useMemo(
    () => [...services].sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name)),
    [services],
  );

  if (sorted.length === 0) return null;

  return (
    <div data-testid="health-strip" className="flex flex-wrap gap-1.5 p-3 px-4 bg-card border border-border rounded-lg">
      {sorted.map((svc) => (
        <button
          key={svc.name}
          onClick={() => onClickService(svc.name)}
          className="flex items-center gap-[5px] px-2.5 py-1 rounded-md bg-secondary/50 hover:bg-secondary transition-colors"
        >
          <span className={`w-[5px] h-[5px] rounded-full ${DOT_COLORS[svc.health]}`} />
          <span className="font-mono text-[10px] font-medium text-foreground/75">{svc.name}</span>
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

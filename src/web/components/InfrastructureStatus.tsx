import type {
  InfrastructureSection,
  SectionStatus,
  ContainerStatus,
  K8sEvent,
} from "../../types/service-brief.js";

interface InfrastructureStatusProps {
  infrastructure: InfrastructureSection | null;
  sectionStatus: SectionStatus;
}

// ── Freshness indicator ───────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function FreshnessIndicator({ fetchedAt }: { fetchedAt?: number }) {
  if (!fetchedAt) return null;

  const ageMs = Date.now() - fetchedAt;
  const ageSec = Math.round(ageMs / 1000);
  const isStale = ageMs > STALE_THRESHOLD_MS;

  return (
    <span
      className={`text-[10px] font-mono ${isStale ? "text-warning" : "text-muted-foreground/50"}`}
    >
      Updated {ageSec}s ago
    </span>
  );
}

// ── Resource parsing ──────────────────────────────────────────────────────────

/**
 * Parse K8s resource strings into a numeric value.
 * "245m" → 245 (millicores, already in base unit)
 * "500m" → 500
 * "312Mi" → 319488 (bytes via 312 * 1024^2) — but we just return the raw number
 * for percentage calculations, so both usage and limit must use the same unit.
 *
 * Strategy: strip any non-numeric/decimal suffix characters, parse the number,
 * then apply a multiplier for known suffixes.
 */
function parseResourceValue(value: string): number {
  if (!value || value === "0") return 0;

  // Match number + optional suffix
  const match = value.match(/^([0-9.]+)([A-Za-z]*)$/);
  if (!match) return 0;

  const num = parseFloat(match[1]);
  const suffix = match[2];

  if (!isFinite(num)) return 0;

  switch (suffix) {
    // CPU: already in millicores — no scaling needed
    case "m":
      return num;
    // CPU: cores → millicores
    case "":
      return num * 1000;
    // Memory: binary prefixes → bytes
    case "Ki":
      return num * 1024;
    case "Mi":
      return num * 1024 * 1024;
    case "Gi":
      return num * 1024 * 1024 * 1024;
    // Memory: decimal prefixes → bytes
    case "K":
      return num * 1000;
    case "M":
      return num * 1000 * 1000;
    case "G":
      return num * 1000 * 1000 * 1000;
    default:
      return num;
  }
}

function usagePct(usage: string, limit: string): number {
  const u = parseResourceValue(usage);
  const l = parseResourceValue(limit);
  if (l === 0) return 0;
  return Math.min(100, (u / l) * 100);
}

// ── Utilization bar ───────────────────────────────────────────────────────────

function UtilBar({ pct }: { pct: number }) {
  let barColor: string;
  if (pct >= 90) {
    barColor = "bg-destructive";
  } else if (pct >= 70) {
    barColor = "bg-warning";
  } else {
    barColor = "bg-success";
  }

  return (
    <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${barColor}`}
        style={{ width: `${pct.toFixed(1)}%` }}
      />
    </div>
  );
}

// ── Container resource card ───────────────────────────────────────────────────

function ContainerCard({ container }: { container: ContainerStatus }) {
  const cpuPct = usagePct(container.cpuUsage, container.cpuLimit);
  const memPct = usagePct(container.memUsage, container.memLimit);
  const hasRestarts = container.restarts > 0;

  return (
    <div className="px-4 py-3 space-y-2">
      {/* Container name */}
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-mono text-foreground/80 font-medium">
          {container.name}
        </span>
        {hasRestarts && (
          <span className="text-[11px] font-mono text-destructive">
            {container.restarts} restart{container.restarts !== 1 ? "s" : ""}
            {container.lastRestartReason
              ? ` · ${container.lastRestartReason}`
              : ""}
          </span>
        )}
      </div>

      {/* CPU */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-body text-muted-foreground/70 font-medium">
            CPU
          </span>
          <span className="text-[11px] font-mono text-foreground/70 tabular-nums">
            {container.cpuUsage} / {container.cpuLimit}
          </span>
        </div>
        <UtilBar pct={cpuPct} />
      </div>

      {/* Memory */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-body text-muted-foreground/70 font-medium">
            Memory
          </span>
          <span className="text-[11px] font-mono text-foreground/70 tabular-nums">
            {container.memUsage} / {container.memLimit}
          </span>
        </div>
        <UtilBar pct={memPct} />
      </div>
    </div>
  );
}

// ── Warning events list ───────────────────────────────────────────────────────

function WarningEvents({ events }: { events: K8sEvent[] }) {
  const warnings = events.filter((e) => e.type === "Warning");
  if (warnings.length === 0) return null;

  return (
    <div>
      <div className="border-t border-border/25" />
      <div className="px-4 pt-3 pb-1">
        <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground/60">
          Recent Events
        </span>
      </div>
      <div className="space-y-0">
        {warnings.map((event, idx) => (
          <div key={`${event.reason}-${idx}`}>
            <div className="flex items-start gap-2 px-4 py-2">
              <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0 mt-1.5" />
              <div className="flex-1 min-w-0">
                <span className="text-[11px] font-mono text-warning font-medium">
                  {event.reason}
                </span>
                <span className="text-[11px] font-body text-muted-foreground ml-1.5 truncate block">
                  {event.message.length > 80
                    ? `${event.message.slice(0, 80)}…`
                    : event.message}
                </span>
              </div>
              {event.count > 1 && (
                <span className="text-[10px] font-mono text-muted-foreground/50 shrink-0">
                  ×{event.count}
                </span>
              )}
            </div>
            {idx < warnings.length - 1 && (
              <div className="border-t border-border/15 mx-4" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="px-4 py-3 space-y-4">
      {/* Workload row */}
      <div className="h-3.5 rounded bg-muted/40 shimmer-skeleton w-2/5" />
      {/* Container blocks */}
      {[1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="h-3 rounded bg-muted/40 shimmer-skeleton w-1/4" />
            <div className="h-3 rounded bg-muted/30 shimmer-skeleton w-1/5" />
          </div>
          <div className="space-y-1.5">
            <div className="h-2.5 rounded bg-muted/30 shimmer-skeleton w-full" />
            <div className="h-1 rounded-full bg-muted/30 shimmer-skeleton w-full" />
          </div>
          <div className="space-y-1.5">
            <div className="h-2.5 rounded bg-muted/30 shimmer-skeleton w-full" />
            <div className="h-1 rounded-full bg-muted/30 shimmer-skeleton w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function InfrastructureStatus({
  infrastructure,
  sectionStatus,
}: InfrastructureStatusProps) {
  return (
    <div className="rounded-lg border border-border/25 bg-card/40 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground/60">
          Infrastructure
        </span>
        <FreshnessIndicator fetchedAt={sectionStatus.fetchedAt} />
      </div>

      {/* Divider under header */}
      <div className="border-t border-border/25" />

      {/* Loading: status ok but data not yet arrived */}
      {sectionStatus.status === "ok" && infrastructure === null && (
        <LoadingSkeleton />
      )}

      {/* Unconfigured */}
      {sectionStatus.status === "unconfigured" && (
        <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
          Connect a K8s provider to see infrastructure
        </div>
      )}

      {/* Error */}
      {sectionStatus.status === "error" && (
        <div className="px-4 py-8 text-center text-[13px] text-destructive">
          Failed to load infrastructure data
        </div>
      )}

      {/* Data or empty */}
      {infrastructure !== null &&
        sectionStatus.status !== "unconfigured" &&
        sectionStatus.status !== "error" &&
        (() => {
          const { workloadType, replicas, containers, recentEvents } =
            infrastructure;

          // Empty: infrastructure present but no containers
          if (containers.length === 0) {
            return (
              <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                No workload data available
              </div>
            );
          }

          return (
            <div>
              {/* Workload info row */}
              <div className="px-4 py-2.5 flex items-center gap-2">
                <span className="text-[12px] font-mono text-foreground/80">
                  {workloadType}
                </span>
                <span className="text-muted-foreground/40 text-[11px]">·</span>
                <span
                  className={`text-[12px] font-mono tabular-nums ${
                    replicas.ready < replicas.desired
                      ? "text-warning"
                      : "text-success"
                  }`}
                >
                  {replicas.ready}/{replicas.desired} ready
                </span>
                {replicas.available !== replicas.desired && (
                  <>
                    <span className="text-muted-foreground/40 text-[11px]">
                      ·
                    </span>
                    <span className="text-[12px] font-mono text-muted-foreground tabular-nums">
                      {replicas.available} available
                    </span>
                  </>
                )}
              </div>

              <div className="border-t border-border/25" />

              {/* Container resource cards */}
              <div className="divide-y divide-border/25">
                {containers.map((container) => (
                  <ContainerCard key={container.name} container={container} />
                ))}
              </div>

              {/* Warning events */}
              <WarningEvents events={recentEvents} />
            </div>
          );
        })()}
    </div>
  );
}

import type {
  ChangesSection,
  SectionStatus,
  Deployment,
  MergeRequest,
  ConfigChange,
} from "../../types/service-brief.js";

interface RecentChangesProps {
  changes: ChangesSection | null;
  sectionStatus: SectionStatus;
}

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;

  const diffYr = Math.floor(diffMo / 12);
  return `${diffYr}y ago`;
}

// ── Unified timeline item ──────────────────────────────────────────────────────

type ChangeType = "deploy" | "mr" | "config";

interface TimelineItem {
  type: ChangeType;
  timestamp: string;
  description: string;
  meta: string;
}

function deploymentToItem(d: Deployment): TimelineItem {
  return {
    type: "deploy",
    timestamp: d.deployedAt,
    description: `Deploy ${d.ref} → ${d.environment}`,
    meta: `${d.deployedBy} · ${formatRelativeTime(d.deployedAt)} · pipeline ${d.pipelineStatus}`,
  };
}

function mergeRequestToItem(mr: MergeRequest): TimelineItem {
  return {
    type: "mr",
    timestamp: mr.mergedAt,
    description: mr.title,
    meta: `${mr.mergedBy} · ${formatRelativeTime(mr.mergedAt)} · ${mr.filesChanged} file${mr.filesChanged !== 1 ? "s" : ""} changed`,
  };
}

function configChangeToItem(c: ConfigChange): TimelineItem {
  const fields =
    c.changedFields && c.changedFields.length > 0
      ? ` (${c.changedFields.join(", ")})`
      : "";
  return {
    type: "config",
    timestamp: c.changedAt,
    description: `${c.resource} ${c.name}${fields}`,
    meta: formatRelativeTime(c.changedAt),
  };
}

function mergeAndSort(changes: ChangesSection): TimelineItem[] {
  const items: TimelineItem[] = [
    ...changes.deployments.map(deploymentToItem),
    ...changes.mergeRequests.map(mergeRequestToItem),
    ...changes.configChanges.map(configChangeToItem),
  ];

  items.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return items.slice(0, 10);
}

// ── Dot colors by type ────────────────────────────────────────────────────────

function dotClass(type: ChangeType): string {
  switch (type) {
    case "deploy":
      return "bg-primary";
    case "mr":
      return "bg-info";
    case "config":
      return "bg-warning";
  }
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

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-0">
      {[1, 2, 3].map((i, idx) => (
        <div key={i}>
          <div className="flex items-start gap-3 px-4 py-3">
            <div className="w-1.5 h-1.5 rounded-full bg-muted/40 shimmer-skeleton mt-1.5 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 rounded bg-muted/40 shimmer-skeleton w-3/5" />
              <div className="h-2.5 rounded bg-muted/30 shimmer-skeleton w-2/5" />
            </div>
          </div>
          {idx < 2 && <div className="border-t border-border/25 mx-4" />}
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function RecentChanges({ changes, sectionStatus }: RecentChangesProps) {
  return (
    <div className="rounded-lg border border-border/25 bg-card/40 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground/60">
          Recent Changes
        </span>
        <FreshnessIndicator fetchedAt={sectionStatus.fetchedAt} />
      </div>

      {/* Divider under header */}
      <div className="border-t border-border/25" />

      {/* Loading */}
      {sectionStatus.status === "ok" && changes === null && (
        <LoadingSkeleton />
      )}

      {/* Unconfigured */}
      {sectionStatus.status === "unconfigured" && (
        <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
          Connect a GitLab provider to see recent changes
        </div>
      )}

      {/* Error */}
      {sectionStatus.status === "error" && (
        <div className="px-4 py-8 text-center text-[13px] text-destructive">
          Failed to load changes
        </div>
      )}

      {/* Data or empty */}
      {changes !== null && sectionStatus.status !== "unconfigured" && sectionStatus.status !== "error" && (() => {
        const items = mergeAndSort(changes);

        if (items.length === 0) {
          return (
            <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
              No recent changes detected
            </div>
          );
        }

        return (
          <div>
            {items.map((item, idx) => (
              <div key={`${item.type}-${item.timestamp}-${idx}`}>
                <div className="flex items-start gap-3 px-4 py-3">
                  {/* Type dot */}
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${dotClass(item.type)}`}
                  />

                  {/* Description + metadata */}
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-body text-foreground truncate">
                      {item.description}
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">
                      {item.meta}
                    </div>
                  </div>
                </div>
                {idx < items.length - 1 && (
                  <div className="border-t border-border/25 mx-4" />
                )}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

// src/web/components/dashboard/EventStream.tsx
import type { RecentEvent } from "../../../types/events.js";
import { OpsDeskSectionHeader } from "./OpsDeskSectionHeader";

interface Props {
  events: RecentEvent[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  /** Navigate to the dedicated /activity/events tab. Renders a "View all →"
   *  affordance via OpsDeskSectionHeader. Optional so existing test fixtures
   *  that don't pass this prop still render. */
  onViewAll?: () => void;
}

const severityDot: Record<RecentEvent["severity"], string> = {
  info: "bg-info",
  warn: "bg-warning",
  error: "bg-destructive",
  success: "bg-success",
};

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const SNIPPET = 5;

export function EventStream({ events, loading, error, truncated, onViewAll }: Props) {
  // `total` is unknown in absolute terms (events live in a ring buffer so the
  // server doesn't keep older ones), but `truncated` tells us "the buffer hit
  // its cap". Passing total=events.length keeps the header honest: it reads
  // "5 of 25" when the buffer is full and just "5" when it isn't.
  const displayed = Math.min(SNIPPET, events.length);
  const total = events.length;
  return (
    <aside aria-label="Recent events" className="mb-4">
      <OpsDeskSectionHeader
        title="Recent Events"
        count={displayed}
        total={total}
        onViewAll={onViewAll}
      />
      <ul role="list" className="divide-y divide-border/30">
        {loading && events.length === 0 ? (
          <li className="px-3 py-4 text-xs text-muted-foreground">Loading…</li>
        ) : error ? (
          <li className="px-3 py-4 text-xs text-destructive">Failed to load events: {error}</li>
        ) : events.length === 0 ? (
          <li className="px-3 py-4 text-xs text-muted-foreground">No recent events.</li>
        ) : (
          // Ops Desk snippet: 5 rows, matching Investigation Log and Recent
          // Scans. The ring buffer's `truncated` flag still surfaces below
          // when the server dropped older entries.
          events.slice(0, SNIPPET).map((e) => (
            // Row typography mirrors RecentScansSection: font-mono text-[11px],
            // so Recent Scans and Recent Events sit visually adjacent without
            // the eye catching on a size change at the section boundary.
            // Previously this row was text-sm body, which read as an outlier.
            <li key={e.id} role="listitem" className="flex items-start gap-2 py-1.5 font-mono text-[11px]">
              <span className={`mt-1.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${severityDot[e.severity]}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-foreground/85 truncate">{e.summary}</div>
                <div className="tabular-nums text-muted-foreground/55 mt-0.5 text-[10px]">{relTime(e.ts)}</div>
              </div>
            </li>
          ))
        )}
      </ul>
      {truncated && (
        <div className="mt-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60">
          older events dropped
        </div>
      )}
    </aside>
  );
}

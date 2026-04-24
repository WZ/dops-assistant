// src/web/components/dashboard/EventStream.tsx
import type { RecentEvent } from "../../../types/events.js";
import { OpsDeskSectionHeader } from "./OpsDeskSectionHeader";

interface Props {
  events: RecentEvent[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
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

export function EventStream({ events, loading, error, truncated }: Props) {
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
            <li key={e.id} role="listitem" className="flex items-start gap-2 py-1.5">
              <span className={`mt-1.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${severityDot[e.severity]}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-foreground/90 truncate">{e.summary}</div>
                <div className="font-mono text-[10px] tabular-nums text-muted-foreground/60 mt-0.5">{relTime(e.ts)}</div>
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

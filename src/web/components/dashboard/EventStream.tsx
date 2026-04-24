// src/web/components/dashboard/EventStream.tsx
import type { RecentEvent } from "../../../types/events.js";

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

export function EventStream({ events, loading, error, truncated }: Props) {
  return (
    <aside aria-label="Recent events" className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
        <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
          Recent events
        </h2>
      </header>
      <ul role="list" className="max-h-[520px] overflow-y-auto divide-y divide-border/60">
        {loading && events.length === 0 ? (
          <li className="px-3 py-4 text-xs text-muted-foreground">Loading…</li>
        ) : error ? (
          <li className="px-3 py-4 text-xs text-destructive">Failed to load events: {error}</li>
        ) : events.length === 0 ? (
          <li className="px-3 py-4 text-xs text-muted-foreground">No recent events.</li>
        ) : (
          // Ops Desk snippet: cap at 5 rows so this section sits consistent
          // with Investigation Log and Recent Scans above. The scroll
          // container's max-height is now decorative — with 5 items it never
          // overflows — but kept so a future "Expand" control or direct-
          // linked /events page can reuse the same component.
          events.slice(0, 5).map((e) => (
            <li key={e.id} role="listitem" className="flex items-start gap-2 px-3 py-2">
              <span className={`mt-1.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${severityDot[e.severity]}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-foreground truncate">{e.summary}</div>
                <div className="font-mono text-[10px] tabular-nums text-muted-foreground/70 mt-0.5">{relTime(e.ts)}</div>
              </div>
            </li>
          ))
        )}
      </ul>
      {truncated && (
        <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60 border-t border-border">
          older events dropped
        </div>
      )}
    </aside>
  );
}

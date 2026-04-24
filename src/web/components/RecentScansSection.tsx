import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../../types/ws-types.js";
import { useStackContext } from "../contexts/StackContext.js";

/**
 * RecentScansSection — Ops Desk card showing recent scan runs.
 *
 * Polls `/api/scan/runs?limit=25` every 10s. Client-side auto-collapses runs
 * of consecutive clean cron ticks (status='complete' AND hits_dispatched=0
 * AND trigger='cron') into summary rows so operators aren't drowning in
 * "all clear" entries. Manual triggers and any run that dispatched
 * investigations render individually.
 *
 * The "⚡ Scan now" button sends a WS `scan:trigger` — the server replies
 * with `scan:started` (when a new run begins) or `scan:skipped` (when a
 * tick is already in flight / the feature is disabled). We optimistically
 * navigate to the run detail on `scan:started`.
 *
 * The parent owns the WebSocket + router — this component only receives
 * wsSend / wsMessages / onOpenRun callbacks. That mirrors `HealthStrip`
 * and `Dashboard`'s delegation pattern (no homegrown navigation here).
 */

/** Subset of ScanRunRow fields the list view needs. See src/server/db.ts ScanRunRow. */
export interface ScanRunListRow {
  id: string;
  trigger: "manual" | "cron";
  status: "running" | "complete" | "failed" | "skipped";
  startedAt: number;
  finishedAt: number | null;
  servicesProbed: number;
  hitsDispatched: number;
}

export type CollapsedEntry =
  | { kind: "row"; row: ScanRunListRow }
  | { kind: "collapsed"; count: number; firstAt: number; lastAt: number };

/**
 * Fold consecutive clean cron ticks (status='complete' AND hits_dispatched=0 AND trigger='cron')
 * into summary groups. Groups of 1 pass through as regular rows. Manual triggers and any
 * run that dispatched investigations render individually. Input order is preserved;
 * rows are expected newest-first (matches `GET /api/scan/runs`).
 */
export function collapseCronTicks(rows: ScanRunListRow[]): CollapsedEntry[] {
  const out: CollapsedEntry[] = [];
  let group: ScanRunListRow[] = [];
  const flush = () => {
    if (group.length >= 2) {
      // Rows are newest-first, so group[0] is the most recent and group[last]
      // is the oldest in this run of ticks. "firstAt" = earliest, "lastAt" = latest.
      out.push({
        kind: "collapsed",
        count: group.length,
        firstAt: group[group.length - 1]!.startedAt,
        lastAt: group[0]!.startedAt,
      });
    } else {
      for (const r of group) out.push({ kind: "row", row: r });
    }
    group = [];
  };
  for (const row of rows) {
    const collapsible =
      row.trigger === "cron" && row.status === "complete" && row.hitsDispatched === 0;
    if (collapsible) {
      group.push(row);
    } else {
      flush();
      out.push({ kind: "row", row });
    }
  }
  flush();
  return out;
}

interface Props {
  /** Scan feature enabled? Drives the button's disabled state + tooltip. */
  scanEnabled: boolean;
  /** WS send function — the Dashboard owns the socket. */
  wsSend: (msg: ClientMessage) => void;
  /** WS inbound messages; used to detect `scan:started` (optimistic nav) + terminal events (reset ticking). */
  wsMessages: ServerMessage[];
  /** Navigate to the run detail page. Parent wires this to whatever router is in use. */
  onOpenRun: (runId: string) => void;
}

export function RecentScansSection({ scanEnabled, wsSend, wsMessages, onOpenRun }: Props) {
  const { stackFetch } = useStackContext();
  const [rows, setRows] = useState<ScanRunListRow[]>([]);
  const [ticking, setTicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Index into wsMessages marking "already processed" — advances each time
  // we react to a scan event so we don't double-handle an old message on the
  // next render. Also set when the operator clicks Scan now, so any prior
  // scan:started from an unrelated tick doesn't trigger a stale navigation.
  const processedIdxRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await stackFetch("/api/scan/runs?limit=25");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { runs: ScanRunListRow[] };
        if (!cancelled) {
          setRows(data.runs);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const id = setInterval(() => {
      void load();
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stackFetch]);

  // React to WS events: scan:started triggers optimistic nav; terminal events
  // (complete/failed/skipped) reset the ticking flag so the button re-enables.
  useEffect(() => {
    if (!ticking) return;
    for (let i = processedIdxRef.current; i < wsMessages.length; i++) {
      const msg = wsMessages[i];
      if (!msg || typeof msg.type !== "string") continue;
      if (msg.type === "scan:started") {
        setTicking(false);
        processedIdxRef.current = i + 1;
        onOpenRun(msg.runId);
        return;
      }
      if (
        msg.type === "scan:complete" ||
        msg.type === "scan:failed" ||
        msg.type === "scan:skipped"
      ) {
        setTicking(false);
        processedIdxRef.current = i + 1;
        return;
      }
    }
  }, [wsMessages, ticking, onOpenRun]);

  const collapsed = useMemo(() => collapseCronTicks(rows), [rows]);

  const handleScanNow = () => {
    // Skip past any existing messages so we only react to events produced by
    // *this* trigger. Without this, a stale scan:started from a prior tick
    // would cause an unwanted navigation.
    processedIdxRef.current = wsMessages.length;
    setTicking(true);
    wsSend({ type: "scan:trigger" });
  };

  const buttonTitle = !scanEnabled
    ? "Enable the scan in Settings \u2192 Scan first"
    : ticking
    ? "A tick is already running"
    : "Fire one probe pass immediately";

  return (
    <section
      aria-label="Recent scans"
      className="rounded-lg border border-border/40 bg-card/50 p-4"
    >
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-3.5 w-0.5 rounded-full bg-primary/60" />
          <h3 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            Recent Scans
          </h3>
        </div>
        <button
          type="button"
          disabled={!scanEnabled || ticking}
          onClick={handleScanNow}
          title={buttonTitle}
          className="h-9 rounded-lg bg-primary px-3 font-mono text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {ticking ? "Starting\u2026" : "\u26A1 Scan now"}
        </button>
      </header>

      {error && (
        <div className="mb-2 font-mono text-[11px] text-destructive">
          Failed to load: {error}
        </div>
      )}

      {rows.length === 0 && !error ? (
        <div className="py-6 text-center text-xs text-muted-foreground/60">
          No scans yet &mdash; click &ldquo;Scan now&rdquo; to start your first one.
        </div>
      ) : (
        <ul className="divide-y divide-border/30 text-sm">
          {collapsed.map((e, i) =>
            e.kind === "collapsed" ? (
              <li
                key={`c-${i}`}
                className="flex items-center gap-2 py-1.5 font-mono text-[11px] text-muted-foreground/70"
              >
                <span className="text-muted-foreground/40">&#9678;</span>
                <span>
                  {e.count} clean cron ticks &middot;{" "}
                  {new Date(e.firstAt).toLocaleTimeString()}&ndash;
                  {new Date(e.lastAt).toLocaleTimeString()}
                </span>
              </li>
            ) : (
              <li
                key={e.row.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpenRun(e.row.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onOpenRun(e.row.id);
                  }
                }}
                className="flex cursor-pointer items-center gap-2 py-1.5 font-mono text-[11px] text-foreground/90 hover:bg-secondary/40"
              >
                <StatusDot status={e.row.status} hits={e.row.hitsDispatched} />
                <span className="text-muted-foreground/70">
                  {new Date(e.row.startedAt).toLocaleTimeString()}
                </span>
                <span className="text-muted-foreground/40">&middot;</span>
                <span>{e.row.trigger}</span>
                <span className="text-muted-foreground/40">&middot;</span>
                <span>{e.row.servicesProbed} probed</span>
                <span className="text-muted-foreground/40">&middot;</span>
                <span
                  className={
                    e.row.hitsDispatched > 0 ? "text-warning" : "text-muted-foreground/70"
                  }
                >
                  {e.row.hitsDispatched} hits
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function StatusDot({
  status,
  hits,
}: {
  status: ScanRunListRow["status"];
  hits: number;
}) {
  const color =
    status === "failed"
      ? "bg-destructive"
      : status === "running"
      ? "bg-primary"
      : status === "skipped"
      ? "bg-muted-foreground/30"
      : hits > 0
      ? "bg-warning"
      : "bg-success";
  return <span className={`inline-block h-[7px] w-[7px] rounded-full ${color}`} aria-hidden />;
}

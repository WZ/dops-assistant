import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useStackContext } from "../contexts/StackContext";
import { Chip, FilterGroup } from "./ui/filter-group";
import {
  resolveRangeToSince,
  stringifyScanRunsQuery,
  type ScanRunsQuery,
  type ScanStatus,
  type ScanTrigger,
  type ScanOutcome,
  type ScanDateRange,
} from "../lib/scan-runs-query";

const DEFAULT_LIMIT = 25;

interface ScanRunRow {
  id: string;
  trigger: "manual" | "cron";
  status: "running" | "complete" | "failed" | "skipped";
  startedAt: number;
  finishedAt: number | null;
  servicesProbed: number;
  rulesApplied: number;
  hitsRaw: number;
  hitsDispatched: number;
  probeDurationMs: number | null;
  errorMessage: string | null;
}

interface ScanRunsListResponse {
  runs: ScanRunRow[];
  total: number;
  hasMore: boolean;
}

interface ScansTabProps {
  query: ScanRunsQuery;
  onUpdateQuery: (query: ScanRunsQuery) => void;
  onOpenScanRun: (runId: string) => void;
}

const STATUS_OPTIONS: { id: ScanStatus; label: string }[] = [
  { id: "complete", label: "Complete" },
  { id: "running", label: "Running" },
  { id: "failed", label: "Failed" },
  { id: "skipped", label: "Skipped" },
];
const TRIGGER_OPTIONS: { id: ScanTrigger; label: string }[] = [
  { id: "cron", label: "Cron" },
  { id: "manual", label: "Manual" },
];
const OUTCOME_OPTIONS: { id: ScanOutcome; label: string; tone: string }[] = [
  { id: "clean", label: "Clean", tone: "text-muted-foreground/80" },
  { id: "tripped", label: "Tripped", tone: "text-warning" },
  { id: "dispatched", label: "Dispatched", tone: "text-destructive" },
];
const RANGE_OPTIONS: { id: ScanDateRange; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d",  label: "7d" },
  { id: "30d", label: "30d" },
];

function fmtRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

/**
 * Determine the "outcome" tone for a row — same rule as the server-side
 * filter: hits_raw=0 → clean, raw>0 dispatched=0 → tripped, dispatched>0 →
 * dispatched. Repeated client-side here because the row endpoint doesn't
 * (yet) return the outcome as its own column.
 */
function outcomeOf(row: ScanRunRow): ScanOutcome {
  if (row.hitsDispatched > 0) return "dispatched";
  if (row.hitsRaw > 0) return "tripped";
  return "clean";
}

/**
 * Activity → Scans tab. Paginated history of every probe tick — manual or
 * cron — with filters on status / trigger / outcome / time range / sort.
 * The Ops Desk's Recent Scans section is the at-a-glance view that links
 * here when the user wants to dig.
 *
 * Each row drills into `/scan/runs/:id` for the per-run dossier. Filters
 * round-trip through the URL (`/activity/scans?status=failed&range=7d`)
 * via `parseScanRunsQuery` / `stringifyScanRunsQuery` in `useRoute`.
 */
export function ScansTab({ query, onUpdateQuery, onOpenScanRun }: ScansTabProps) {
  const { stackFetch } = useStackContext();
  const [rows, setRows] = useState<ScanRunRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchSeqRef = useRef(0);

  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;

  const fetchUrl = useMemo(() => {
    const resolved = resolveRangeToSince({ ...query, limit, offset });
    const qs = stringifyScanRunsQuery(resolved);
    return qs ? `/api/scan/runs?${qs}` : "/api/scan/runs";
  }, [query, limit, offset]);

  useEffect(() => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    const controller = new AbortController();

    stackFetch(fetchUrl, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(body || `HTTP ${res.status}`);
        }
        return res.json() as Promise<ScanRunsListResponse>;
      })
      .then((data) => {
        if (seq !== fetchSeqRef.current) return;
        setRows(data.runs);
        setTotal(data.total);
        setHasMore(data.hasMore);
        // Auto-correct over-the-end pagination on bookmarked URLs (same
        // pattern as InvestigationsPage).
        if (data.runs.length === 0 && data.total > 0 && offset > 0) {
          const next: ScanRunsQuery = { ...query };
          delete next.offset;
          onUpdateQuery(next);
        }
      })
      .catch((err) => {
        if (err.name === "AbortError" || seq !== fetchSeqRef.current) return;
        setError(err.message || "Failed to load scan runs");
        setRows([]);
        setTotal(0);
        setHasMore(false);
      })
      .finally(() => {
        if (seq === fetchSeqRef.current) setLoading(false);
      });

    return () => controller.abort();
  }, [stackFetch, fetchUrl]);

  const goPrev = useCallback(() => {
    const nextOffset = Math.max(0, offset - limit);
    onUpdateQuery({ ...query, offset: nextOffset === 0 ? undefined : nextOffset });
  }, [offset, limit, query, onUpdateQuery]);
  const goNext = useCallback(() => {
    onUpdateQuery({ ...query, offset: offset + limit });
  }, [offset, limit, query, onUpdateQuery]);

  /** Toggle a value in a multi-select array filter. Empty arrays → key unset. */
  function toggleMulti<K extends "status" | "trigger" | "outcome">(
    key: K,
    value: NonNullable<ScanRunsQuery[K]>[number],
  ) {
    const current = new Set((query[key] ?? []) as string[]);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    const next: ScanRunsQuery = { ...query };
    delete next.offset; // any filter change resets pagination
    if (current.size === 0) delete next[key];
    else (next[key] as unknown as string[]) = Array.from(current);
    onUpdateQuery(next);
  }

  function setRange(range: ScanDateRange | undefined) {
    const next: ScanRunsQuery = { ...query };
    delete next.offset;
    if (range) next.range = range;
    else delete next.range;
    onUpdateQuery(next);
  }

  function setSort(sort: "started_at" | "duration") {
    const next: ScanRunsQuery = { ...query };
    delete next.offset;
    if (sort === "started_at") delete next.sort;
    else next.sort = sort;
    onUpdateQuery(next);
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);
  const hasActiveFilters = Boolean(
    query.status?.length || query.trigger?.length || query.outcome?.length ||
    query.range || query.since || query.until,
  );

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <div>
        <div className="mb-6 animate-fade-up">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90">
            Scans
          </h1>
          <p className="text-xs font-mono text-muted-foreground/70 mt-1 tracking-wide">
            {loading && rows.length === 0 ? "…" : `${total.toLocaleString()} total`}
            {hasActiveFilters && (
              <>
                <span className="text-muted-foreground/40 mx-1.5">&middot;</span>
                <span className="text-primary/70 uppercase">filtered</span>
              </>
            )}
          </p>
        </div>

        {/* Filter bar — chips for multi-select filters + range presets +
            sort dropdown. Same FilterGroup/Chip layout as PatternsTab,
            EventsTab, and InvestigationsPage so all activity views feel
            like the same family. */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <FilterGroup label="Status">
            {STATUS_OPTIONS.map((o) => (
              <Chip
                key={o.id}
                active={(query.status ?? []).includes(o.id)}
                onClick={() => toggleMulti("status", o.id)}
              >
                {o.label}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup label="Trigger">
            {TRIGGER_OPTIONS.map((o) => (
              <Chip
                key={o.id}
                active={(query.trigger ?? []).includes(o.id)}
                onClick={() => toggleMulti("trigger", o.id)}
              >
                {o.label}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup label="Outcome">
            {OUTCOME_OPTIONS.map((o) => (
              <Chip
                key={o.id}
                active={(query.outcome ?? []).includes(o.id)}
                onClick={() => toggleMulti("outcome", o.id)}
                tone={o.tone}
              >
                {o.label}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup label="Range">
            {RANGE_OPTIONS.map((o) => (
              <Chip
                key={o.id}
                active={query.range === o.id}
                onClick={() => setRange(query.range === o.id ? undefined : o.id)}
              >
                {o.label}
              </Chip>
            ))}
            <Chip active={!query.range} onClick={() => setRange(undefined)}>All</Chip>
          </FilterGroup>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">Sort</span>
            <select
              value={query.sort ?? "started_at"}
              onChange={(e) => setSort(e.target.value as "started_at" | "duration")}
              className="font-mono text-[10px] uppercase tracking-[0.12em] px-2 h-7 rounded-md border border-border/40 bg-card/30 text-foreground/80"
            >
              <option value="started_at">Most recent</option>
              <option value="duration">Slowest first</option>
            </select>
          </div>
        </div>

        {error && (
          <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive/90">
            <div className="font-medium">Could not load scans</div>
            <div className="text-xs text-destructive/70 mt-1">{error}</div>
          </div>
        )}

        {loading && rows.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-16 rounded-lg shimmer-skeleton"
                style={{ animationDelay: `${i * 0.06}s` }}
              />
            ))}
          </div>
        ) : rows.length === 0 && !error ? (
          <div className="py-16 flex flex-col items-center gap-3 text-center">
            <p className="font-display text-sm font-semibold text-muted-foreground/60">
              {hasActiveFilters ? "No scans match" : "No scans yet"}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground/40">
              {hasActiveFilters
                ? "Try broadening the filters or date range"
                : "Scans appear here when the proactive scanner runs"}
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => onUpdateQuery({})}
                className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-primary hover:text-primary/80"
              >
                Clear all filters
              </button>
            )}
          </div>
        ) : (
          <ul className="space-y-1.5" data-testid="scans-list">
            {rows.map((row) => (
              <ScanRunListRow
                key={row.id}
                row={row}
                onClick={() => onOpenScanRun(row.id)}
              />
            ))}
          </ul>
        )}

        {total > 0 && (
          <footer className="mt-4 flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground/60">
              {pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={goPrev}
                disabled={offset === 0 || loading}
                className="font-mono text-[10px] uppercase tracking-[0.12em] px-3 h-8 rounded-md border border-border/40 text-foreground/75 hover:bg-card/70 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ← Prev
              </button>
              <button
                onClick={goNext}
                disabled={!hasMore || loading}
                className="font-mono text-[10px] uppercase tracking-[0.12em] px-3 h-8 rounded-md border border-border/40 text-foreground/75 hover:bg-card/70 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next →
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

function ScanRunListRow({ row, onClick }: { row: ScanRunRow; onClick: () => void }) {
  const outcome = outcomeOf(row);
  const stripeColor = row.status === "failed"
    ? "bg-destructive"
    : outcome === "dispatched"
      ? "bg-destructive/70"
      : outcome === "tripped"
        ? "bg-warning/80"
        : row.status === "running"
          ? "bg-primary/60 animate-pulse"
          : "bg-muted-foreground/30";
  const duration = row.finishedAt && row.startedAt
    ? fmtDuration(row.finishedAt - row.startedAt)
    : row.probeDurationMs !== null
      ? fmtDuration(row.probeDurationMs)
      : "—";
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left relative pl-3 pr-3 py-2.5 rounded-lg border border-border/40 bg-card/30 hover:bg-card/70 hover:border-border transition-colors group"
      >
        <span className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-sm ${stripeColor}`} />
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70 w-14 shrink-0">
            {row.trigger}
          </span>
          <span className="font-mono text-xs text-foreground/85 tabular-nums w-20 shrink-0">
            {fmtRelative(row.startedAt)}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground/70 tabular-nums w-16 shrink-0">
            {duration}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground/70 tabular-nums w-20 shrink-0">
            {row.servicesProbed} svc
          </span>
          <span className={`font-mono text-[11px] tabular-nums w-24 shrink-0 ${
            outcome === "dispatched"
              ? "text-destructive"
              : outcome === "tripped"
                ? "text-warning"
                : "text-muted-foreground/60"
          }`}>
            {row.hitsDispatched > 0
              ? `${row.hitsDispatched} dispatched`
              : row.hitsRaw > 0
                ? `${row.hitsRaw} tripped`
                : "clean"}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60 ml-auto">
            {row.status === "failed" && row.errorMessage
              ? row.errorMessage.slice(0, 60)
              : row.status}
          </span>
        </div>
      </button>
    </li>
  );
}

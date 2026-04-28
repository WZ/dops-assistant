import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useStackContext } from "../contexts/StackContext";
import { Chip, FilterGroup } from "./ui/filter-group";
import { useSlashFocus } from "../hooks/useSlashFocus";
import {
  resolveRangeToSince,
  stringifyEventsQuery,
  type EventsQuery,
  type EventSeverity,
  type EventDateRange,
} from "../lib/events-query";

const DEFAULT_LIMIT = 50;

interface EventRow {
  id: string;
  ts: number;
  kind: string;
  severity: string;
  summary: string;
  stackId: string | null;
  service: string | null;
  href: string | null;
  meta: Record<string, string | number | boolean> | null;
}

interface EventsListResponse {
  rows: EventRow[];
  total: number;
  hasMore: boolean;
  /** Distinct kinds in this stack — populates the kind-filter dropdown. */
  kinds: string[];
  /** Distinct services in this stack — populates the service-filter dropdown. */
  services: string[];
}

interface EventsTabProps {
  query: EventsQuery;
  onUpdateQuery: (query: EventsQuery) => void;
  /** Used to navigate when an event row has an `href` like `/investigations/inv_…`. */
  onNavigate: (href: string) => void;
}

const SEVERITY_OPTIONS: { id: EventSeverity; label: string; tone: string }[] = [
  { id: "error",   label: "Error",   tone: "text-destructive" },
  { id: "warn",    label: "Warn",    tone: "text-warning" },
  { id: "info",    label: "Info",    tone: "text-foreground/70" },
  { id: "success", label: "Success", tone: "text-success" },
];
const RANGE_OPTIONS: { id: EventDateRange; label: string }[] = [
  { id: "1h",  label: "1h" },
  { id: "24h", label: "24h" },
  { id: "7d",  label: "7d" },
  { id: "30d", label: "30d" },
];

const SEVERITY_DOT: Record<string, string> = {
  info: "bg-info",
  warn: "bg-warning",
  error: "bg-destructive",
  success: "bg-success",
};

function fmtRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/**
 * Pretty-print an event kind. The DB stores raw enum values like
 * `investigation_completed`. The Ops Desk strip never rendered the kind
 * (just summary + timestamp), but on a dedicated page operators want to
 * scan by kind. Format underscores → spaces, capitalize first letter.
 */
function fmtKind(kind: string): string {
  if (!kind) return "";
  const spaced = kind.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Activity → Events tab. Persistent, filterable activity feed backed by the
 * `events` table — the durable replacement for the Ops Desk's in-memory ring
 * buffer (which only kept the latest 200 events and dropped older ones
 * silently). Filter chips for severity + range presets, kind/service
 * dropdowns, search box, paginated rows.
 *
 * Click on a row with an `href` → navigate to it (typically a linked
 * investigation). Rows without `href` (process-wide events like server
 * lifecycle, probe transitions) render as non-interactive.
 */
export function EventsTab({ query, onUpdateQuery, onNavigate }: EventsTabProps) {
  const { stackFetch } = useStackContext();
  const [rows, setRows] = useState<EventRow[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchSeqRef = useRef(0);

  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;

  const fetchUrl = useMemo(() => {
    const resolved = resolveRangeToSince({ ...query, limit, offset });
    const qs = stringifyEventsQuery(resolved);
    return qs ? `/api/events?${qs}` : "/api/events";
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
        return res.json() as Promise<EventsListResponse>;
      })
      .then((data) => {
        if (seq !== fetchSeqRef.current) return;
        setRows(data.rows);
        setKinds(data.kinds ?? []);
        setServices(data.services ?? []);
        setTotal(data.total);
        setHasMore(data.hasMore);
        if (data.rows.length === 0 && data.total > 0 && offset > 0) {
          const next: EventsQuery = { ...query };
          delete next.offset;
          onUpdateQuery(next);
        }
      })
      .catch((err) => {
        if (err.name === "AbortError" || seq !== fetchSeqRef.current) return;
        setError(err.message || "Failed to load events");
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

  function toggleSeverity(value: EventSeverity) {
    const current = new Set(query.severity ?? []);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    const next: EventsQuery = { ...query };
    delete next.offset;
    if (current.size === 0) delete next.severity;
    else next.severity = Array.from(current);
    onUpdateQuery(next);
  }

  function setRange(range: EventDateRange | undefined) {
    const next: EventsQuery = { ...query };
    delete next.offset;
    if (range) next.range = range;
    else delete next.range;
    onUpdateQuery(next);
  }

  function setService(service: string | undefined) {
    const next: EventsQuery = { ...query };
    delete next.offset;
    if (service) next.service = service;
    else delete next.service;
    onUpdateQuery(next);
  }

  function setKind(kind: string | undefined) {
    const next: EventsQuery = { ...query };
    delete next.offset;
    if (kind) next.kind = [kind];
    else delete next.kind;
    onUpdateQuery(next);
  }

  // Search committed on Enter / blur, not per-keystroke (matches PatternsTab).
  const [qDraft, setQDraft] = useState(query.q ?? "");
  useEffect(() => { setQDraft(query.q ?? ""); }, [query.q]);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  function commitQ() {
    const trimmed = qDraft.trim();
    if (trimmed === (query.q ?? "")) return;
    const next: EventsQuery = { ...query };
    delete next.offset;
    if (trimmed) next.q = trimmed;
    else delete next.q;
    onUpdateQuery(next);
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);
  const hasActiveFilters = Boolean(
    query.kind?.length || query.severity?.length || query.service ||
    query.range || query.since || query.until || query.q,
  );
  const selectedKind = query.kind?.[0] ?? "";

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <div>
        <div className="mb-6 animate-fade-up">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90">
            Events
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

        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <FilterGroup label="Severity">
            {SEVERITY_OPTIONS.map((o) => (
              <Chip
                key={o.id}
                active={(query.severity ?? []).includes(o.id)}
                onClick={() => toggleSeverity(o.id)}
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
          <FilterGroup label="Kind">
            <select
              value={selectedKind}
              onChange={(e) => setKind(e.target.value || undefined)}
              className="font-mono text-[10px] uppercase tracking-[0.12em] px-2 h-7 rounded-md border border-border/40 bg-card/30 text-foreground/80 max-w-[14rem] truncate"
              data-testid="events-kind-select"
            >
              <option value="">All kinds</option>
              {kinds.map((k) => (
                <option key={k} value={k}>{fmtKind(k)}</option>
              ))}
            </select>
          </FilterGroup>
          <FilterGroup label="Service">
            <select
              value={query.service ?? ""}
              onChange={(e) => setService(e.target.value || undefined)}
              className="font-mono text-[10px] uppercase tracking-[0.12em] px-2 h-7 rounded-md border border-border/40 bg-card/30 text-foreground/80 max-w-[12rem] truncate"
              data-testid="events-service-select"
            >
              <option value="">All services</option>
              {services.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </FilterGroup>
          <FilterGroup label="Search">
            <div className="relative">
              <input
                ref={searchRef}
                type="search"
                value={qDraft}
                onChange={(e) => setQDraft(e.target.value)}
                onBlur={commitQ}
                onKeyDown={(e) => { if (e.key === "Enter") commitQ(); }}
                placeholder="summary text…"
                className="font-mono text-[11px] px-2 h-7 rounded-md border border-border/40 bg-card/30 text-foreground/80 placeholder:text-muted-foreground/40 w-56"
                data-testid="events-search-input"
              />
              {!qDraft && (
                <kbd className="absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-[8px] text-muted-foreground/30 border border-border/30 rounded px-1 py-0.5 pointer-events-none">/</kbd>
              )}
            </div>
          </FilterGroup>
        </div>

        {error && (
          <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive/90">
            <div className="font-medium">Could not load events</div>
            <div className="text-xs text-destructive/70 mt-1">{error}</div>
          </div>
        )}

        {loading && rows.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-12 rounded-lg shimmer-skeleton"
                style={{ animationDelay: `${i * 0.05}s` }}
              />
            ))}
          </div>
        ) : rows.length === 0 && !error ? (
          <div className="py-16 flex flex-col items-center gap-3 text-center">
            <p className="font-display text-sm font-semibold text-muted-foreground/60">
              {hasActiveFilters ? "No events match" : "No events yet"}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground/40">
              {hasActiveFilters
                ? "Try broadening the filters or date range"
                : "Events appear here as investigations run, scans tick, and health changes"}
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
          <ul className="space-y-1" data-testid="events-list">
            {rows.map((row) => (
              <EventListRow
                key={row.id}
                row={row}
                onClick={() => row.href && onNavigate(row.href)}
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

function EventListRow({ row, onClick }: { row: EventRow; onClick: () => void }) {
  const dot = SEVERITY_DOT[row.severity] ?? SEVERITY_DOT["info"]!;
  const clickable = Boolean(row.href);
  return (
    <li>
      <button
        type="button"
        onClick={clickable ? onClick : undefined}
        disabled={!clickable}
        className={`w-full text-left px-3 py-2 rounded-md border border-border/30 bg-card/20 transition-colors ${
          clickable ? "hover:bg-card/60 hover:border-border/60" : "cursor-default"
        }`}
      >
        <div className="flex items-start gap-3">
          <span className={`mt-1.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70 w-32 shrink-0 mt-0.5 truncate">
            {fmtKind(row.kind)}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground/70 tabular-nums w-20 shrink-0 mt-0.5">
            {fmtRelative(row.ts)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-body text-xs text-foreground/85 truncate">
              {row.summary}
            </div>
            {row.service && (
              <div className="font-mono text-[10px] text-muted-foreground/55 truncate mt-0.5">
                {row.service}
              </div>
            )}
          </div>
          {clickable && (
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/50 ml-2 mt-0.5">
              open →
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

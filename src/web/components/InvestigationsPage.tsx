import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useStackContext } from "../contexts/StackContext";
import { InvestigationRow } from "./dashboard/InvestigationRow";
import type {
  InvestigationSummary,
  InvestigationListResponse,
} from "../lib/dashboard-utils";
import type {
  InvestigationsQuery,
  Severity,
  Status,
  Sort,
  DateRange,
} from "../lib/investigations-query";
import {
  resolveRangeToSince,
  stringifyInvestigationsQuery,
} from "../lib/investigations-query";

const DEFAULT_LIMIT = 25;

interface InvestigationsPageProps {
  query: InvestigationsQuery;
  onUpdateQuery: (query: InvestigationsQuery) => void;
  onViewInvestigation: (id: string) => void;
}

const SEVERITY_OPTIONS: { id: Severity; label: string; tone: string }[] = [
  { id: "critical", label: "Critical", tone: "text-destructive" },
  { id: "high",     label: "High",     tone: "text-warning" },
  { id: "medium",   label: "Medium",   tone: "text-foreground/70" },
  { id: "low",      label: "Low",      tone: "text-muted-foreground/70" },
];
const STATUS_OPTIONS: { id: Status; label: string }[] = [
  { id: "running",  label: "Running" },
  { id: "complete", label: "Complete" },
  { id: "failed",   label: "Failed" },
];
const RANGE_OPTIONS: { id: DateRange; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d",  label: "7d" },
  { id: "30d", label: "30d" },
];
const SORT_OPTIONS: { id: Sort; label: string }[] = [
  { id: "created_at", label: "Most recent" },
  { id: "confidence", label: "Highest confidence" },
];

export function InvestigationsPage({
  query,
  onUpdateQuery,
  onViewInvestigation,
}: InvestigationsPageProps) {
  const { stackFetch, activeStackId } = useStackContext();
  const [rows, setRows] = useState<InvestigationSummary[]>([]);
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
    const qs = stringifyInvestigationsQuery(resolved);
    return qs ? `/api/investigations?${qs}` : "/api/investigations";
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
        return res.json() as Promise<InvestigationListResponse>;
      })
      .then((data) => {
        if (seq !== fetchSeqRef.current) return;
        setRows(data.rows);
        setServices(data.services ?? []);
        setTotal(data.total);
        setHasMore(data.hasMore);
        if (data.rows.length === 0 && data.total > 0 && offset > 0) {
          const next: InvestigationsQuery = { ...query };
          delete next.offset;
          onUpdateQuery(next);
        }
      })
      .catch((err) => {
        if (err.name === "AbortError" || seq !== fetchSeqRef.current) return;
        setError(err.message || "Failed to load investigations");
        setRows([]);
        setServices([]);
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

  // Search committed on Enter / blur (matches PatternsTab).
  const [qDraft, setQDraft] = useState(query.q ?? "");
  useEffect(() => { setQDraft(query.q ?? ""); }, [query.q]);

  // Every chip/select handler routes through this so any pending qDraft is
  // folded into the same update. Without it, typing in search → clicking a
  // chip silently drops the pending text: blur and click race for the same
  // setState batch and the chip handler closes over a `query` that hasn't
  // seen the q commit yet.
  function withPendingSearch(): InvestigationsQuery {
    const trimmed = qDraft.trim();
    const base: InvestigationsQuery = { ...query };
    if (trimmed) base.q = trimmed;
    else delete base.q;
    return base;
  }

  function toggleSeverity(value: Severity) {
    const current = new Set(query.severity ?? []);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    const next = withPendingSearch();
    delete next.offset;
    if (current.size === 0) delete next.severity;
    else next.severity = Array.from(current);
    onUpdateQuery(next);
  }

  function toggleStatus(value: Status) {
    const current = new Set(query.status ?? []);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    const next = withPendingSearch();
    delete next.offset;
    if (current.size === 0) delete next.status;
    else next.status = Array.from(current);
    onUpdateQuery(next);
  }

  function setRange(range: DateRange | undefined) {
    const next = withPendingSearch();
    delete next.offset;
    // Switching presets implies dropping any custom since/until window so the
    // active chip and the actual filter agree (mirrors the old segmented
    // control's behavior).
    delete next.since;
    delete next.until;
    if (range) next.range = range;
    else delete next.range;
    onUpdateQuery(next);
  }

  function setService(service: string | undefined) {
    const next = withPendingSearch();
    delete next.offset;
    if (service) next.service = service;
    else delete next.service;
    onUpdateQuery(next);
  }

  function setSort(sort: Sort) {
    const next = withPendingSearch();
    delete next.offset;
    if (sort === "created_at") delete next.sort;
    else next.sort = sort;
    onUpdateQuery(next);
  }

  function commitQ() {
    const trimmed = qDraft.trim();
    if (trimmed === (query.q ?? "")) return;
    const next: InvestigationsQuery = { ...query };
    delete next.offset;
    if (trimmed) next.q = trimmed;
    else delete next.q;
    onUpdateQuery(next);
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);
  const hasActiveFilters = Boolean(
    (query.severity && query.severity.length > 0) ||
      (query.status && query.status.length > 0) ||
      query.service ||
      query.range ||
      query.since ||
      query.until ||
      query.q ||
      query.sort,
  );
  // "All" range chip is active only when no range AND no custom window —
  // matches the previous segmented control's "no preset glows when a custom
  // since is set" behavior.
  const allRangeActive = !query.range && !query.since && !query.until;
  const activeSort = query.sort ?? "created_at";

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <div>
        <div className="mb-6 animate-fade-up">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90">
            Investigations
          </h1>
          <p className="text-xs font-mono text-muted-foreground/70 mt-1 tracking-wide">
            {loading && rows.length === 0
              ? "…"
              : `${total.toLocaleString()} total`}
            {hasActiveFilters && (
              <>
                <span className="text-muted-foreground/40 mx-1.5">&middot;</span>
                <span className="text-primary/70 uppercase">filtered</span>
              </>
            )}
          </p>
        </div>

        <div
          role="search"
          aria-label="Filter investigations"
          className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs"
        >
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
          <FilterGroup label="Status">
            {STATUS_OPTIONS.map((o) => (
              <Chip
                key={o.id}
                active={(query.status ?? []).includes(o.id)}
                onClick={() => toggleStatus(o.id)}
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
            <Chip active={allRangeActive} onClick={() => setRange(undefined)}>All</Chip>
          </FilterGroup>
          <FilterGroup label="Service">
            <select
              value={query.service ?? ""}
              onChange={(e) => setService(e.target.value || undefined)}
              className="font-mono text-[10px] uppercase tracking-[0.12em] px-2 h-7 rounded-md border border-border/40 bg-card/30 text-foreground/80 max-w-[12rem] truncate"
              data-testid="investigations-service-select"
              aria-label="Filter by service"
            >
              <option value="">All services</option>
              {services.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </FilterGroup>
          <FilterGroup label="Search">
            <input
              type="search"
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              onBlur={commitQ}
              onKeyDown={(e) => { if (e.key === "Enter") commitQ(); }}
              placeholder="symptom or root cause…"
              className="font-mono text-[11px] px-2 h-7 rounded-md border border-border/40 bg-card/30 text-foreground/80 placeholder:text-muted-foreground/40 w-56"
              data-testid="investigations-search-input"
              aria-label="Search investigations"
            />
          </FilterGroup>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">Sort</span>
            <select
              value={activeSort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="font-mono text-[10px] uppercase tracking-[0.12em] px-2 h-7 rounded-md border border-border/40 bg-card/30 text-foreground/80"
              aria-label="Sort by"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive/90"
          >
            <div className="font-medium">Could not load investigations</div>
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
              {hasActiveFilters ? "No investigations match" : "No investigations yet"}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground/40">
              {hasActiveFilters
                ? "Try broadening the filters or date range"
                : "Investigations will appear here as they run"}
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
          <div className="space-y-1.5">
            {rows.map((inv) => (
              <InvestigationRow
                key={inv.id}
                investigation={inv}
                onClick={onViewInvestigation}
                stackId={activeStackId}
              />
            ))}
          </div>
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

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
        {label}
      </span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`font-mono text-[10px] uppercase tracking-[0.12em] px-2 h-7 rounded-md border transition-colors ${
        active
          ? "border-primary/60 bg-primary/10 text-primary"
          : `border-border/40 ${tone ?? "text-foreground/70"} hover:bg-card/70 hover:text-foreground`
      }`}
    >
      {children}
    </button>
  );
}

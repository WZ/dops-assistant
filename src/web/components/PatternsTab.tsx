import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useStackContext } from "../contexts/StackContext";
import { Chip, FilterGroup } from "./ui/filter-group";
import { useSlashFocus } from "../hooks/useSlashFocus";
import {
  resolveRangeToSince,
  stringifyPatternsQuery,
  type PatternsQuery,
  type PatternSeverity,
  type PatternDateRange,
} from "../lib/patterns-query";

const DEFAULT_LIMIT = 25;

interface PatternRow {
  id: string;
  service: string;
  symptom: string;
  root_cause: string;
  severity: string;
  recommended_actions: string | null;
  source_investigation_id: string | null;
  created_at: string;
}

interface PatternsListResponse {
  rows: PatternRow[];
  total: number;
  hasMore: boolean;
  /** Distinct service names with at least one pattern in this stack — populates the service filter dropdown. */
  services: string[];
}

interface PatternsTabProps {
  query: PatternsQuery;
  onUpdateQuery: (query: PatternsQuery) => void;
  onViewPattern: (id: string) => void;
  onViewInvestigation: (id: string) => void;
}

const SEVERITY_OPTIONS: { id: PatternSeverity; label: string; tone: string }[] = [
  { id: "critical", label: "Critical", tone: "text-destructive" },
  { id: "high",     label: "High",     tone: "text-warning" },
  { id: "medium",   label: "Medium",   tone: "text-foreground/70" },
  { id: "low",      label: "Low",      tone: "text-muted-foreground/70" },
];
const RANGE_OPTIONS: { id: PatternDateRange; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d",  label: "7d" },
  { id: "30d", label: "30d" },
];

const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive",
  high:     "bg-warning/15 text-warning",
  medium:   "bg-info/15 text-info",
  low:      "bg-secondary text-muted-foreground",
};

function fmtRelative(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/**
 * Activity → Patterns tab. List of every learned `incident_pattern` for the
 * resolved stack, with filter chips (severity, range), service dropdown,
 * search across symptom/root_cause/actions, and pagination.
 *
 * Patterns are 1:1 with investigations (one thumbs-up per investigation
 * extracts at most one pattern row), so two recurrences of the same kind of
 * incident on the same service show as two separate rows here. Operators do
 * their own visual clustering by filtering by service. AP15 (deferred —
 * see docs/TODOS.md) makes recurrence first-class with a /patterns/:id
 * detail page once volume justifies a similarity strategy.
 *
 * Click row -> open pattern detail; source affordance opens source investigation.
 */
export function PatternsTab({ query, onUpdateQuery, onViewPattern, onViewInvestigation }: PatternsTabProps) {
  const { stackFetch } = useStackContext();
  const [rows, setRows] = useState<PatternRow[]>([]);
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
    const qs = stringifyPatternsQuery(resolved);
    return qs ? `/api/patterns?${qs}` : "/api/patterns";
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
        return res.json() as Promise<PatternsListResponse>;
      })
      .then((data) => {
        if (seq !== fetchSeqRef.current) return;
        setRows(data.rows);
        setServices(data.services ?? []);
        setTotal(data.total);
        setHasMore(data.hasMore);
        // Auto-correct over-the-end pagination on bookmarked URLs.
        if (data.rows.length === 0 && data.total > 0 && offset > 0) {
          const next: PatternsQuery = { ...query };
          delete next.offset;
          onUpdateQuery(next);
        }
      })
      .catch((err) => {
        if (err.name === "AbortError" || seq !== fetchSeqRef.current) return;
        setError(err.message || "Failed to load patterns");
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

  function toggleSeverity(value: PatternSeverity) {
    const current = new Set(query.severity ?? []);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    const next: PatternsQuery = { ...query };
    delete next.offset;
    if (current.size === 0) delete next.severity;
    else next.severity = Array.from(current);
    onUpdateQuery(next);
  }

  function setRange(range: PatternDateRange | undefined) {
    const next: PatternsQuery = { ...query };
    delete next.offset;
    if (range) next.range = range;
    else delete next.range;
    onUpdateQuery(next);
  }

  function setService(service: string | undefined) {
    const next: PatternsQuery = { ...query };
    delete next.offset;
    if (service) next.service = service;
    else delete next.service;
    onUpdateQuery(next);
  }

  function setSort(sort: "created_at" | "severity") {
    const next: PatternsQuery = { ...query };
    delete next.offset;
    if (sort === "created_at") delete next.sort;
    else next.sort = sort;
    onUpdateQuery(next);
  }

  // Debounce-light: write q on blur or Enter, not on every keystroke.
  const [qDraft, setQDraft] = useState(query.q ?? "");
  useEffect(() => { setQDraft(query.q ?? ""); }, [query.q]);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  function commitQ() {
    const trimmed = qDraft.trim();
    if (trimmed === (query.q ?? "")) return;
    const next: PatternsQuery = { ...query };
    delete next.offset;
    if (trimmed) next.q = trimmed;
    else delete next.q;
    onUpdateQuery(next);
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);
  const hasActiveFilters = Boolean(
    query.service || query.severity?.length ||
    query.range || query.since || query.until || query.q,
  );

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <div>
        <div className="mb-6 animate-fade-up">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90">
            Patterns
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
          <FilterGroup label="Service">
            <select
              value={query.service ?? ""}
              onChange={(e) => setService(e.target.value || undefined)}
              className="font-mono text-[10px] uppercase tracking-[0.12em] px-2 h-7 rounded-md border border-border/40 bg-card/30 text-foreground/80 max-w-[12rem] truncate"
              data-testid="patterns-service-select"
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
                placeholder="symptom or root cause…"
                className="font-mono text-[11px] px-2 h-7 rounded-md border border-border/40 bg-card/30 text-foreground/80 placeholder:text-muted-foreground/40 w-56"
                data-testid="patterns-search-input"
              />
              {!qDraft && (
                <kbd className="absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-[8px] text-muted-foreground/30 border border-border/30 rounded px-1 py-0.5 pointer-events-none">/</kbd>
              )}
            </div>
          </FilterGroup>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">Sort</span>
            <select
              value={query.sort ?? "created_at"}
              onChange={(e) => setSort(e.target.value as "created_at" | "severity")}
              className="font-mono text-[10px] uppercase tracking-[0.12em] px-2 h-7 rounded-md border border-border/40 bg-card/30 text-foreground/80"
            >
              <option value="created_at">Most recent</option>
              <option value="severity">Severity</option>
            </select>
          </div>
        </div>

        {error && (
          <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive/90">
            <div className="font-medium">Could not load patterns</div>
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
              {hasActiveFilters ? "No patterns match" : "No patterns yet"}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground/40">
              {hasActiveFilters
                ? "Try broadening the filters or date range"
                : "Patterns appear here when you give an investigation a 👍"}
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
          <ul className="space-y-1.5" data-testid="patterns-list">
            {rows.map((row) => (
              <PatternListRow
                key={row.id}
                row={row}
                onOpenPattern={() => onViewPattern(row.id)}
                onOpenInvestigation={row.source_investigation_id
                  ? () => onViewInvestigation(row.source_investigation_id!)
                  : undefined}
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

function PatternListRow({
  row,
  onOpenPattern,
  onOpenInvestigation,
}: {
  row: PatternRow;
  onOpenPattern: () => void;
  onOpenInvestigation?: () => void;
}) {
  const badgeClass = SEVERITY_BADGE[row.severity] ?? SEVERITY_BADGE["medium"]!;
  return (
    <li>
      <div className="w-full relative pl-3 pr-3 py-2.5 rounded-lg border border-border/40 bg-card/30 transition-colors hover:bg-card/70 hover:border-border">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={onOpenPattern}
            className="min-w-0 flex-1 text-left flex items-start gap-3"
          >
            <span className={`font-mono text-[10px] uppercase tracking-[0.12em] px-1.5 h-5 rounded inline-flex items-center shrink-0 ${badgeClass}`}>
            {row.severity}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground/70 tabular-nums w-20 shrink-0 mt-0.5">
            {fmtRelative(row.created_at)}
            </span>
            <span className="font-body text-xs text-foreground/85 w-32 shrink-0 truncate mt-0.5">
            {row.service}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-body text-xs text-foreground/85 truncate">{row.symptom}</div>
              <div className="font-mono text-[10px] text-muted-foreground/60 truncate mt-0.5">
                {row.root_cause}
              </div>
            </div>
          </button>
          {onOpenInvestigation && (
            <button
              type="button"
              onClick={onOpenInvestigation}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/50 hover:text-primary ml-2 mt-0.5 shrink-0"
            >
              source →
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

import { useEffect, useState, useRef, useCallback } from "react";
import { useStackContext } from "../contexts/StackContext";
import { InvestigationRow } from "./dashboard/InvestigationRow";
import { SeverityBreakdown } from "./investigations/SeverityBreakdown";
import { InvestigationFilters } from "./investigations/InvestigationFilters";
import type {
  InvestigationSummary,
  InvestigationListResponse,
} from "../lib/dashboard-utils";
import type { InvestigationsQuery, Severity } from "../lib/investigations-query";
import { stringifyInvestigationsQuery } from "../lib/investigations-query";

const DEFAULT_LIMIT = 25;

interface InvestigationsPageProps {
  query: InvestigationsQuery;
  onUpdateQuery: (query: InvestigationsQuery) => void;
  onViewInvestigation: (id: string) => void;
  onBack: () => void;
}

/**
 * Dedicated /investigations list page. PR 2 ships the shell only:
 * data fetch + pagination driven by URL state, no filter UI. PR 3 adds
 * the filter bar + severity breakdown strip. PR 4 adds polish.
 *
 * Query is owned by the parent (App.tsx) so URL ↔ state sync lives in
 * one place (useRoute). This component just renders the current query's
 * data and fires onUpdateQuery for user-driven changes (pagination today,
 * filter inputs in PR 3).
 */
export function InvestigationsPage({
  query,
  onUpdateQuery,
  onViewInvestigation,
  onBack,
}: InvestigationsPageProps) {
  const { stackFetch } = useStackContext();
  const [rows, setRows] = useState<InvestigationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Avoid showing stale data from a prior fetch if the user paginates
  // faster than the network responds. Each fetch bumps a sequence number;
  // only the latest wins.
  const fetchSeqRef = useRef(0);

  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;

  useEffect(() => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    const controller = new AbortController();

    const qs = stringifyInvestigationsQuery({
      ...query,
      limit,
      offset,
    });
    const url = qs ? `/api/investigations?${qs}` : "/api/investigations";

    stackFetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(body || `HTTP ${res.status}`);
        }
        return res.json() as Promise<InvestigationListResponse>;
      })
      .then((data) => {
        if (seq !== fetchSeqRef.current) return; // stale — a newer fetch already won
        setRows(data.rows);
        setTotal(data.total);
        setHasMore(data.hasMore);
      })
      .catch((err) => {
        if (err.name === "AbortError" || seq !== fetchSeqRef.current) return;
        setError(err.message || "Failed to load investigations");
        setRows([]);
        setTotal(0);
        setHasMore(false);
      })
      .finally(() => {
        if (seq === fetchSeqRef.current) setLoading(false);
      });

    return () => controller.abort();
  }, [stackFetch, query, limit, offset]);

  const goPrev = useCallback(() => {
    const nextOffset = Math.max(0, offset - limit);
    onUpdateQuery({ ...query, offset: nextOffset === 0 ? undefined : nextOffset });
  }, [offset, limit, query, onUpdateQuery]);

  const goNext = useCallback(() => {
    onUpdateQuery({ ...query, offset: offset + limit });
  }, [offset, limit, query, onUpdateQuery]);

  const toggleSeverity = useCallback(
    (sev: Severity) => {
      const current = new Set(query.severity ?? []);
      if (current.has(sev)) current.delete(sev);
      else current.add(sev);
      const next: InvestigationsQuery = { ...query };
      delete next.offset; // severity change resets pagination
      if (current.size === 0) delete next.severity;
      else next.severity = Array.from(current);
      onUpdateQuery(next);
    },
    [query, onUpdateQuery],
  );

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);
  const hasActiveFilters = Boolean(
    (query.severity && query.severity.length > 0) ||
      (query.status && query.status.length > 0) ||
      query.service ||
      query.since ||
      query.until ||
      query.q,
  );

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-[1100px] mx-auto px-6 py-6">
        <header className="mb-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onBack}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60 hover:text-foreground/80 transition-colors"
              aria-label="Back to dashboard"
            >
              ← Dashboard
            </button>
            <div className="w-px h-4 bg-border/40" />
            <h1 className="font-display text-xl font-semibold text-foreground/90 truncate">
              Investigations
            </h1>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground/50">
              {loading && rows.length === 0 ? "…" : total.toLocaleString()}
            </span>
          </div>
        </header>

        <SeverityBreakdown query={query} onToggleSeverity={toggleSeverity} />
        <InvestigationFilters query={query} onUpdateQuery={onUpdateQuery} />

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

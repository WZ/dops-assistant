import { useEffect, useState, useMemo } from "react";
import type {
  InvestigationsQuery,
  Status,
  Sort,
} from "../../lib/investigations-query";

interface InvestigationFiltersProps {
  query: InvestigationsQuery;
  onUpdateQuery: (query: InvestigationsQuery) => void;
}

const STATUS_OPTIONS: ReadonlyArray<{ key: Status; label: string }> = [
  { key: "running", label: "Running" },
  { key: "complete", label: "Complete" },
  { key: "failed", label: "Failed" },
];

const SORT_OPTIONS: ReadonlyArray<{ key: Sort; label: string }> = [
  { key: "created_at", label: "Most recent" },
  { key: "confidence", label: "Highest confidence" },
];

type DatePreset = "24h" | "7d" | "30d" | "all";

const PRESET_MS: Record<Exclude<DatePreset, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const DATE_PRESETS: ReadonlyArray<{ key: DatePreset; label: string }> = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

/**
 * Figure out which preset, if any, matches the current `since` value. We
 * consider it a match if `since` is within 60s of what the preset would emit
 * right now — the user may have loaded the URL a minute ago, and the presets
 * should still round-trip to "7d" instead of falling back to "custom". For
 * anything truly custom (hand-edited URL with an arbitrary timestamp), we
 * show no preset active and don't hide the fact in the UI.
 */
function detectPreset(since: string | undefined): DatePreset {
  if (!since) return "all";
  const parsed = Date.parse(since);
  if (!Number.isFinite(parsed)) return "all";
  const delta = Date.now() - parsed;
  for (const key of ["24h", "7d", "30d"] as const) {
    if (Math.abs(delta - PRESET_MS[key]) < 60_000) return key;
  }
  return "all";
}

/**
 * Return a new query with the preset applied. "all" clears `since`; presets
 * emit an absolute ISO timestamp so the URL is shareable and snapshot-stable.
 * We deliberately don't preserve `until` — the presets mean "the last N",
 * which is always open-ended on the right edge.
 */
function applyPreset(query: InvestigationsQuery, preset: DatePreset): InvestigationsQuery {
  const next: InvestigationsQuery = { ...query };
  delete next.offset; // resetting the date window should reset pagination
  delete next.until;
  if (preset === "all") {
    delete next.since;
  } else {
    next.since = new Date(Date.now() - PRESET_MS[preset]).toISOString();
  }
  return next;
}

function toggleStatus(query: InvestigationsQuery, status: Status): InvestigationsQuery {
  const current = new Set(query.status ?? []);
  if (current.has(status)) current.delete(status);
  else current.add(status);
  const next: InvestigationsQuery = { ...query };
  delete next.offset;
  if (current.size === 0) delete next.status;
  else next.status = Array.from(current);
  return next;
}

function hasAnyFilter(query: InvestigationsQuery): boolean {
  return Boolean(
    (query.severity && query.severity.length > 0) ||
      (query.status && query.status.length > 0) ||
      query.service ||
      query.since ||
      query.until ||
      query.q ||
      query.sort,
  );
}

export function InvestigationFilters({ query, onUpdateQuery }: InvestigationFiltersProps) {
  // Local mirror for the search input so typing doesn't thrash the URL on
  // every keystroke. Synced back to the URL after a 300ms idle.
  const [localQ, setLocalQ] = useState(query.q ?? "");

  // Keep the input in sync with external query changes (e.g. Clear, back/forward).
  useEffect(() => {
    setLocalQ(query.q ?? "");
  }, [query.q]);

  // Debounce: commit to the URL after 300ms of quiet typing. If the user is
  // still typing, the timer resets and the URL stays where it was — prevents
  // the page from firing a fetch on every keystroke.
  useEffect(() => {
    if (localQ === (query.q ?? "")) return;
    const t = setTimeout(() => {
      const next: InvestigationsQuery = { ...query };
      delete next.offset; // new search = new page 1
      if (localQ) next.q = localQ;
      else delete next.q;
      onUpdateQuery(next);
    }, 300);
    return () => clearTimeout(t);
  }, [localQ, query, onUpdateQuery]);

  const activePreset = useMemo(() => detectPreset(query.since), [query.since]);
  const activeStatus = new Set<Status>(query.status ?? []);
  const activeSort = query.sort ?? "created_at";
  const showClear = hasAnyFilter(query);

  return (
    <div
      role="search"
      aria-label="Filter investigations"
      className="flex flex-wrap items-center gap-2 mb-4 pb-4 border-b border-border/30"
    >
      {/* Search input — grows to fill available width */}
      <div className="relative flex-1 min-w-[180px] max-w-[360px]">
        <input
          type="search"
          value={localQ}
          onChange={(e) => setLocalQ(e.target.value)}
          placeholder="Search by service, query, or root cause"
          className="w-full h-9 pl-3 pr-3 rounded-md border border-border/40 bg-card/40 text-sm text-foreground/90 placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 focus:bg-card/60 transition-colors"
          aria-label="Search investigations"
        />
      </div>

      {/* Status pills */}
      <div className="flex items-center gap-1" role="group" aria-label="Filter by status">
        {STATUS_OPTIONS.map(({ key, label }) => {
          const isActive = activeStatus.has(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onUpdateQuery(toggleStatus(query, key))}
              aria-pressed={isActive}
              className={`h-8 px-3 rounded-md border text-[11px] font-mono uppercase tracking-[0.08em] transition-colors ${
                isActive
                  ? "bg-primary/15 border-primary/60 text-primary"
                  : "border-border/40 text-foreground/70 hover:bg-card/70"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Date range — segmented presets */}
      <div
        role="group"
        aria-label="Date range"
        className="flex items-center rounded-md border border-border/40 overflow-hidden"
      >
        {DATE_PRESETS.map(({ key, label }, i) => {
          const isActive = activePreset === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onUpdateQuery(applyPreset(query, key))}
              aria-pressed={isActive}
              className={`h-8 px-3 text-[11px] font-mono uppercase tracking-[0.08em] transition-colors ${
                isActive
                  ? "bg-primary/15 text-primary"
                  : "text-foreground/70 hover:bg-card/70"
              } ${i > 0 ? "border-l border-border/40" : ""}`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Sort */}
      <label className="relative flex items-center">
        <span className="sr-only">Sort by</span>
        <select
          value={activeSort}
          onChange={(e) => {
            const next: InvestigationsQuery = { ...query };
            const value = e.target.value as Sort;
            if (value === "created_at") delete next.sort;
            else next.sort = value;
            // Changing sort reorders the whole list, so a user on page 2+
            // would otherwise land in the middle of the newly-sorted results
            // and miss the rows they actually asked for (e.g. "Highest
            // confidence" should start at the highest, not row 26).
            delete next.offset;
            onUpdateQuery(next);
          }}
          className="h-8 pl-3 pr-7 rounded-md border border-border/40 bg-card/40 text-[11px] font-mono uppercase tracking-[0.08em] text-foreground/75 focus:outline-none focus:border-primary/60 appearance-none cursor-pointer"
        >
          {SORT_OPTIONS.map(({ key, label }) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2 text-foreground/50 text-[10px]">▾</span>
      </label>

      {/* Clear */}
      {showClear && (
        <button
          type="button"
          onClick={() => onUpdateQuery({})}
          className="ml-auto h-8 px-2 text-[11px] font-mono uppercase tracking-[0.08em] text-muted-foreground/70 hover:text-foreground transition-colors"
        >
          Clear
        </button>
      )}
    </div>
  );
}

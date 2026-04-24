import { useEffect, useMemo, useRef, useState } from "react";
import { useStackContext } from "../../contexts/StackContext";
import type {
  InvestigationsQuery,
  Severity,
} from "../../lib/investigations-query";
import {
  resolveRangeToSince,
  stringifyInvestigationsQuery,
} from "../../lib/investigations-query";

interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface SeverityBreakdownProps {
  query: InvestigationsQuery;
  onToggleSeverity: (severity: Severity) => void;
}

const SEVERITIES: ReadonlyArray<{
  key: Severity;
  label: string;
  /** Tailwind classes for the active (selected) pill state. */
  activeClasses: string;
  /** Tailwind classes for the inactive state — shared across severities so
   *  the resting visual weight doesn't push the eye toward "low" or "medium"
   *  before the user has decided what to look at. */
  inactiveClasses: string;
}> = [
  {
    key: "critical",
    label: "Critical",
    activeClasses: "bg-destructive/15 border-destructive text-destructive",
    inactiveClasses: "border-destructive/35 text-destructive/85 hover:bg-destructive/10",
  },
  {
    key: "high",
    label: "High",
    activeClasses: "bg-accent/20 border-accent text-accent-foreground",
    inactiveClasses: "border-accent/35 text-accent/90 hover:bg-accent/10",
  },
  {
    key: "medium",
    label: "Medium",
    activeClasses: "bg-warning/20 border-warning text-warning",
    inactiveClasses: "border-warning/35 text-warning/90 hover:bg-warning/10",
  },
  {
    key: "low",
    label: "Low",
    activeClasses: "bg-info/20 border-info text-info",
    inactiveClasses: "border-info/35 text-info/90 hover:bg-info/10",
  },
];

export function SeverityBreakdown({ query, onToggleSeverity }: SeverityBreakdownProps) {
  const { stackFetch } = useStackContext();
  const [counts, setCounts] = useState<SeverityCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const active = new Set<Severity>(query.severity ?? []);

  // Stale-response guard: abort alone isn't enough when a response is already
  // in-flight through .then() at the moment the next query arrives. A slow
  // earlier fetch can setCounts AFTER a faster later fetch, briefly showing
  // counts from the previous filter set. Every fetch bumps this counter; only
  // the latest wins.
  const fetchSeqRef = useRef(0);

  // Strip severity/limit/offset/sort (histogram doesn't self-filter, and the
  // count endpoint ignores pagination + sort anyway), resolve range → since,
  // then serialize. Memoized on `query` identity but the resulting URL string
  // is a stable primitive — identical content produces identical strings, so
  // the effect below skips re-running on parent re-renders that produce a new
  // `query` ref with the same values. Also means clicking a severity pill no
  // longer triggers a refetch (severity is stripped out of the URL before
  // serialization, so the fetch URL is unchanged by the pill toggle).
  const fetchUrl = useMemo(() => {
    const filterForCounts: InvestigationsQuery = { ...query };
    delete filterForCounts.severity;
    delete filterForCounts.limit;
    delete filterForCounts.offset;
    delete filterForCounts.sort;
    const qs = stringifyInvestigationsQuery(resolveRangeToSince(filterForCounts));
    return qs
      ? `/api/investigations/severity-counts?${qs}`
      : "/api/investigations/severity-counts";
  }, [query]);

  useEffect(() => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setErrored(false);
    const controller = new AbortController();

    stackFetch(fetchUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<SeverityCounts>;
      })
      .then((data) => {
        if (seq !== fetchSeqRef.current) return; // stale — a newer fetch already won
        setCounts(data);
      })
      .catch((err) => {
        if (err.name === "AbortError" || seq !== fetchSeqRef.current) return;
        // Don't clear previous counts on error — keep the last-known-good
        // numbers visible and surface the failure via em-dashes on pills that
        // haven't been populated yet. Rendering 0s would make the user think
        // their filter matched nothing when the server is actually down.
        setErrored(true);
      })
      .finally(() => {
        if (seq === fetchSeqRef.current) setLoading(false);
      });

    return () => controller.abort();
  }, [stackFetch, fetchUrl]);

  return (
    <div
      role="group"
      aria-label="Filter by severity"
      className="flex flex-wrap items-center gap-2 mb-4"
    >
      {SEVERITIES.map(({ key, label, activeClasses, inactiveClasses }) => {
        const isActive = active.has(key);
        const count = counts?.[key];
        const isDisabled = !loading && !errored && count === 0 && !isActive;
        const display =
          loading && count === undefined ? "…"
          : errored && count === undefined ? "—"
          : (count ?? 0).toLocaleString();
        return (
          <button
            key={key}
            type="button"
            onClick={() => onToggleSeverity(key)}
            disabled={isDisabled}
            aria-pressed={isActive}
            title={errored ? "Couldn't load counts" : undefined}
            className={`flex items-center gap-2 px-3 h-8 rounded-full border text-[11px] font-mono uppercase tracking-[0.1em] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isActive ? activeClasses : inactiveClasses}`}
          >
            <span>{label}</span>
            <span className="tabular-nums font-semibold">{display}</span>
          </button>
        );
      })}
      {errored && (
        <span
          role="alert"
          className="ml-1 text-[10px] font-mono uppercase tracking-[0.12em] text-destructive/70"
        >
          counts unavailable
        </span>
      )}
    </div>
  );
}

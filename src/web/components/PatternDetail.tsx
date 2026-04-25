import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useStackContext } from "../contexts/StackContext";

interface PatternDetailRow {
  id: string;
  service: string;
  symptom: string;
  root_cause: string;
  severity: string;
  recommended_actions: string | null;
  source_investigation_id: string | null;
  created_at: string;
}

interface PatternOccurrence extends PatternDetailRow {
  similarityScore: number;
  investigation?: {
    id: string;
    status: string;
    query: string;
    created_at: string;
    completed_at: string | null;
  } | null;
}

interface PatternClusterResponse {
  seed: PatternDetailRow;
  clusterId: string;
  recurrenceCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  occurrences: PatternOccurrence[];
  dedupedRecommendedActions: string[];
  matchBasis: {
    strategy: string;
    serviceScoped: boolean;
    severity: string;
    rootCauseThreshold: number;
    symptomBoost: boolean;
  };
}

interface PatternDetailProps {
  patternId: string;
  onBack: () => void;
  onViewInvestigation: (id: string) => void;
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-destructive",
  high: "bg-destructive",
  medium: "bg-warning",
  low: "bg-info",
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: "border-destructive/50 bg-destructive/10 text-destructive",
  high: "border-accent/50 bg-accent/10 text-accent",
  medium: "border-warning/50 bg-warning/10 text-warning",
  low: "border-info/50 bg-info/10 text-info",
};

function formatDate(iso: string | null): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}

function rangeLabel(first: string | null, last: string | null): string {
  if (!first || !last) return "unknown";
  const firstMs = Date.parse(first);
  const lastMs = Date.parse(last);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return "unknown";
  const days = Math.max(0, Math.round((lastMs - firstMs) / 86_400_000));
  return days === 0 ? "same day" : `${days}d`;
}

export function PatternDetail({ patternId, onBack, onViewInvestigation }: PatternDetailProps) {
  const { stackFetch } = useStackContext();
  const [data, setData] = useState<PatternClusterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await stackFetch(`/api/patterns/${encodeURIComponent(patternId)}`, { signal });
      if (!res.ok) {
        const message = await res.text().catch(() => "");
        setData(null);
        setError({ status: res.status, message: message || `HTTP ${res.status}` });
        return;
      }
      setData(await res.json() as PatternClusterResponse);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setData(null);
      setError({ status: 0, message: err instanceof Error ? err.message : "Failed to load pattern" });
    } finally {
      setLoading(false);
    }
  }, [patternId, stackFetch]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const headerStats = useMemo(() => {
    if (!data) return null;
    return {
      seen: `seen ${data.recurrenceCount} ${data.recurrenceCount === 1 ? "time" : "times"}`,
      range: rangeLabel(data.firstSeen, data.lastSeen),
    };
  }, [data]);

  if (loading && !data) {
    return (
      <div className="h-full overflow-y-auto bg-background px-5 py-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
          Loading pattern...
        </div>
        <div className="mt-4 space-y-3">
          <div className="h-24 rounded-lg shimmer-skeleton" />
          <div className="h-48 rounded-lg shimmer-skeleton" />
        </div>
      </div>
    );
  }

  if (error) {
    const notFound = error.status === 404;
    return (
      <div className="h-full overflow-y-auto bg-background px-5 py-5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <div role={notFound ? undefined : "alert"} className="mt-6 rounded-lg border border-border bg-card p-5">
          <h1 className="font-display text-xl font-semibold text-foreground">
            {notFound ? "Pattern not found" : "Could not load pattern"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {notFound ? "This learned pattern does not exist in the active stack." : error.message}
          </p>
          {!notFound && (
            <button
              type="button"
              onClick={() => void load()}
              className="mt-4 rounded-md border border-border px-3 h-8 font-mono text-[10px] uppercase tracking-[0.12em] text-foreground/80 hover:bg-secondary"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!data || !headerStats) return null;

  const badgeClass = SEVERITY_BADGE[data.seed.severity] ?? SEVERITY_BADGE.medium;

  return (
    <div className="h-full overflow-y-auto bg-background px-5 py-5">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <article className="rounded-lg border border-border bg-card p-5 shadow-sm">
        <header className="flex items-start justify-between gap-5 border-b border-border pb-4">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <span className="h-4 w-1 rounded-full bg-primary shadow-[0_0_16px_rgba(45,212,168,0.25)]" />
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                Learned Pattern
              </span>
              <span className={`inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] uppercase tracking-[0.12em] ${badgeClass}`}>
                {data.seed.severity}
              </span>
            </div>
            <h1 className="font-display text-2xl font-semibold leading-tight text-foreground">
              {data.seed.root_cause}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {data.seed.service}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 shrink-0">
            <StatTile value={String(data.recurrenceCount)} label={headerStats.seen} />
            <StatTile value={headerStats.range} label="range" />
          </div>
        </header>

        <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
          <section className="space-y-4">
            <DetailBlock label="Symptom">
              {data.seed.symptom}
            </DetailBlock>
            <div>
              <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                Deduped Recommended Actions
              </h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.dedupedRecommendedActions.length > 0 ? data.dedupedRecommendedActions.map((action) => (
                  <span
                    key={action}
                    className="rounded-md border border-primary/25 bg-primary/10 px-2 py-1 font-mono text-[10px] text-primary"
                  >
                    {action}
                  </span>
                )) : (
                  <span className="font-mono text-[10px] text-muted-foreground/70">no actions captured</span>
                )}
              </div>
            </div>
          </section>

          <aside className="border-l border-border pl-4">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Occurrence Timeline
            </h2>
            <div className="relative mt-3 space-y-3">
              <div className="absolute left-[4px] top-2 bottom-2 w-px bg-border" />
              {data.occurrences.map((occurrence) => (
                <div key={occurrence.id} className="relative grid grid-cols-[12px_1fr] gap-2">
                  <span className={`mt-1 h-2.5 w-2.5 rounded-full ${SEVERITY_DOT[occurrence.severity] ?? "bg-muted-foreground"}`} />
                  <div>
                    <div className="font-mono text-[11px] text-foreground">{formatDate(occurrence.created_at)}</div>
                    <div className="text-xs text-muted-foreground">{occurrence.severity} · score {occurrence.similarityScore}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-md border border-border bg-muted/40 p-3">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                Match Basis
              </h3>
              <p className="mt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                {data.matchBasis.strategy} · service scoped · severity {data.matchBasis.severity} · root threshold {data.matchBasis.rootCauseThreshold}
              </p>
            </div>
          </aside>
        </div>
      </article>

      <section className="mt-4 rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Matching Investigations
          </h2>
          <span className="font-mono text-[10px] text-muted-foreground">
            {data.occurrences.length} source cases
          </span>
        </div>
        <ul className="space-y-2">
          {data.occurrences.map((occurrence) => (
            <li key={occurrence.id} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
              {occurrence.investigation ? (
                <button
                  type="button"
                  onClick={() => onViewInvestigation(occurrence.investigation!.id)}
                  aria-label={`Open investigation ${occurrence.investigation.id}`}
                  className="grid w-full grid-cols-[110px_minmax(0,1fr)_80px] items-center gap-3 text-left"
                >
                  <span className="font-mono text-[11px] text-muted-foreground">{formatDate(occurrence.created_at)}</span>
                  <span className="truncate text-sm text-foreground">{occurrence.investigation.query}</span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-primary">open</span>
                </button>
              ) : (
                <div className="grid grid-cols-[110px_minmax(0,1fr)_80px] items-center gap-3">
                  <span className="font-mono text-[11px] text-muted-foreground">{formatDate(occurrence.created_at)}</span>
                  <span className="truncate text-sm text-muted-foreground">source investigation unavailable</span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">missing</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-center">
      <div className="font-mono text-lg font-semibold text-primary">{value}</div>
      <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
    </div>
  );
}

function DetailBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</h2>
      <p className="mt-2 text-sm leading-relaxed text-foreground">{children}</p>
    </div>
  );
}

import { useState, useEffect } from "react";
import { useStackContext } from "../contexts/StackContext";
import { formatTimestamp } from "../lib/formatTimestamp";

interface ServiceHistoryProps {
  serviceName: string;
  onViewInvestigation: (id: string) => void;
}

interface InvestigationRow {
  id: string;
  service: string;
  query: string;
  status: "complete" | "failed" | "running";
  confidence_score: number | null;
  created_at: string;
  completed_at: string | null;
  total_duration_ms: number | null;
  report?: string | null;
}

function extractReportSummary(report?: string | null): string | null {
  if (!report) return null;
  try {
    const parsed = JSON.parse(report);
    return parsed.summary && parsed.summary !== "Investigation complete" ? parsed.summary : null;
  } catch { return null; }
}

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;

  const diffYr = Math.floor(diffMo / 12);
  return `${diffYr}y ago`;
}

export function ServiceHistory({ serviceName, onViewInvestigation }: ServiceHistoryProps) {
  const { stackFetch } = useStackContext();
  const [investigations, setInvestigations] = useState<InvestigationRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);

    const controller = new AbortController();

    stackFetch(`/api/investigations?service=${encodeURIComponent(serviceName)}&limit=20`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        // PR 1 standardized the API on {rows, total, hasMore}. The old
        // compat shim (Array.isArray fallback) is gone — anyone reading stale
        // pre-PR-1 cached bundles gets a clear error instead of silent drift.
        setInvestigations(data.rows ?? []);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setInvestigations([]);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [serviceName]);

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-14 rounded-lg border border-border/25 bg-card/40 shimmer-skeleton"
          />
        ))}
      </div>
    );
  }

  if (investigations.length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-[13px] text-muted-foreground">
        No investigations yet. Click &lsquo;Investigate&rsquo; to start one.
      </div>
    );
  }

  return (
    <div className="max-w-[900px]">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50 mb-3">
        Investigation History
      </div>
      <div className="h-px bg-border/25 mb-4" />

      {/* Timeline */}
      <div className="relative pl-6">
        {/* Vertical line */}
        <div className="absolute left-[5px] top-1 bottom-1 w-px bg-border/25" />

        {investigations.map((inv, idx) => {
          const score = inv.confidence_score != null
            ? (inv.confidence_score <= 1 ? inv.confidence_score : inv.confidence_score / 100)
            : null;
          const dotColor = inv.status === "failed"
            ? "bg-destructive border-destructive"
            : score !== null && score >= 0.8
              ? "bg-destructive border-destructive"
              : score !== null && score >= 0.5
                ? "bg-warning border-warning"
                : "bg-info border-info";
          const summary = extractReportSummary(inv.report);

          return (
            <button
              key={inv.id}
              onClick={() => onViewInvestigation(inv.id)}
              className={`relative w-full text-left group ${idx < investigations.length - 1 ? "mb-5" : ""}`}
            >
              {/* Timeline dot */}
              <div className={`absolute -left-6 top-1 w-[11px] h-[11px] rounded-full border-2 ${dotColor}`} />

              {/* Content */}
              <div
                className="font-mono text-[10px] text-muted-foreground/50 mb-0.5"
                title={formatTimestamp(inv.created_at, "relative")}
              >
                {formatTimestamp(inv.created_at, "utc")}
              </div>
              <div className="text-[13px] font-medium text-foreground/90 group-hover:text-primary transition-colors">
                {inv.query}
              </div>
              {summary && (
                <div className="text-[12px] text-muted-foreground/70 mt-1 line-clamp-2">
                  {summary}
                </div>
              )}
              <div className="text-[12px] text-muted-foreground/60 mt-0.5">
                {inv.status === "complete" ? "Completed" : inv.status === "failed" ? "Failed" : "Running"}
                {score !== null && ` · Confidence: ${score.toFixed(2)}`}
                {inv.total_duration_ms ? ` · ${(inv.total_duration_ms / 1000).toFixed(0)}s` : ""}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

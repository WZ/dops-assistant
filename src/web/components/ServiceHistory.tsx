import { useState, useEffect } from "react";

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
  const [investigations, setInvestigations] = useState<InvestigationRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);

    const controller = new AbortController();

    fetch(`/api/investigations?service=${encodeURIComponent(serviceName)}&limit=20`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setInvestigations(Array.isArray(data) ? data : data.investigations ?? []);
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
    <div className="space-y-2">
      {investigations.map((inv) => (
        <button
          key={inv.id}
          onClick={() => onViewInvestigation(inv.id)}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border/25 bg-card/40 hover:bg-card/60 transition-colors text-left"
        >
          {/* Status dot */}
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              inv.status === "complete"
                ? "bg-success"
                : inv.status === "failed"
                  ? "bg-destructive"
                  : "bg-info animate-status-pulse"
            }`}
          />

          {/* Query text */}
          <span className="text-[13px] flex-1 truncate">{inv.query}</span>

          {/* Right side: confidence + timestamp */}
          <div className="text-right shrink-0">
            {inv.confidence_score != null && (
              <div className="text-[11px] font-mono text-primary">
                {inv.confidence_score <= 1 ? Math.round(inv.confidence_score * 100) : Math.round(inv.confidence_score)}% confidence
              </div>
            )}
            <div className="text-[11px] font-mono text-muted-foreground">
              {formatRelativeTime(inv.created_at)} &middot;{" "}
              {inv.total_duration_ms
                ? `${(inv.total_duration_ms / 1000).toFixed(0)}s`
                : "—"}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

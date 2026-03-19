import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface InvestigationSummary {
  id: string;
  service: string;
  status: string; // "complete" | "failed" | "running"
  report: string | null; // JSON string with { rootCause, confidence, severity, summary, ... }
  created_at: string; // ISO timestamp
  total_input_tokens: number;
  total_output_tokens: number;
  total_duration_ms: number;
}

interface InvestigationRowProps {
  investigation: InvestigationSummary;
  onClick: (id: string) => void;
  className?: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const secs = totalSeconds % 60;
    return secs > 0 ? `${totalMinutes}m ${secs}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type BadgeVariant = "destructive" | "warning" | "secondary" | "outline";

function severityVariant(severity: string): BadgeVariant {
  switch (severity?.toLowerCase()) {
    case "critical":
      return "destructive";
    case "high":
      return "warning";
    case "medium":
      return "secondary";
    default:
      return "outline";
  }
}

export function InvestigationRow({
  investigation: inv,
  onClick,
  className,
}: InvestigationRowProps) {
  let rootCause = "";
  let confidence: unknown = "";
  let severity = "";

  if (inv.report) {
    try {
      const r = JSON.parse(inv.report);
      rootCause = r.rootCause ?? "";
      confidence = r.confidence ?? "";
      severity = r.severity ?? "";
    } catch {
      // ignore malformed JSON
    }
  }

  const statusColor =
    inv.status === "complete"
      ? "bg-success"
      : inv.status === "failed"
        ? "bg-destructive"
        : "bg-accent animate-status-pulse";

  const totalTokens = (inv.total_input_tokens ?? 0) + (inv.total_output_tokens ?? 0);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      onClick(inv.id);
    }
  };

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => onClick(inv.id)}
      onKeyDown={handleKeyDown}
      className={cn(
        "group cursor-pointer rounded-lg border border-border/40 bg-card/40 hover:bg-card/70 hover:border-primary/25 px-4 py-3 transition-all card-lift",
        className,
      )}
    >
      {/* Line 1: dot + service + severity + (right-aligned) confidence + tokens + duration */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${statusColor}`} />
          <span className="font-body text-sm font-medium text-foreground/80 group-hover:text-foreground/95 transition-colors truncate">
            {inv.service}
          </span>
          {severity && (
            <Badge
              variant={severityVariant(severity)}
              className="flex-shrink-0 text-[10px] py-0 h-4 uppercase"
            >
              {severity}
            </Badge>
          )}
        </div>

        {/* Right-aligned metrics */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {confidence !== "" && confidence != null && (
            <span className="font-mono text-[10px] text-foreground/60">
              {typeof confidence === "number"
                ? `${Math.round(confidence * 100)}%`
                : String(confidence).includes("%")
                  ? String(confidence)
                  : `${confidence}%`}
            </span>
          )}
          {totalTokens > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground/50">
              {formatTokens(totalTokens)}
            </span>
          )}
          {inv.total_duration_ms > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground/65">
              {formatDuration(inv.total_duration_ms)}
            </span>
          )}
          <span className="font-mono text-[10px] text-muted-foreground/65">
            {timeAgo(inv.created_at)}
          </span>
        </div>
      </div>

      {/* Line 2: root cause (indented under service name) */}
      {rootCause && (
        <p className="text-xs text-muted-foreground/50 truncate pl-3.5 mt-0.5 font-body">
          {rootCause}
        </p>
      )}
    </div>
  );
}

import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatTokens } from "@/lib/formatTokens";
import { formatDuration, normalizeConfidence, severityVariant, timeAgo } from "@/lib/dashboard-utils";
import type { InvestigationSummary } from "@/lib/dashboard-utils";

interface InvestigationRowProps {
  investigation: InvestigationSummary;
  onClick: (id: string) => void;
  className?: string;
}

export const InvestigationRow = memo(function InvestigationRow({
  investigation: inv,
  onClick,
  className,
}: InvestigationRowProps) {
  let rootCause = "";
  let confidenceDisplay = "";
  let severity = "";

  if (inv.report) {
    try {
      const r = JSON.parse(inv.report);
      rootCause = r.rootCause ?? "";
      confidenceDisplay = normalizeConfidence(r.confidenceScore ?? r.confidence);
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
          {confidenceDisplay && (
            <span className="font-mono text-[10px] text-foreground/60">
              {confidenceDisplay}
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
});

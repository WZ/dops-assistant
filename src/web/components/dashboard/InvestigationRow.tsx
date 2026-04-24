import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatTokens } from "@/lib/formatTokens";
import { formatDuration, inferTriggerSource, normalizeConfidence, severityVariant, timeAgo } from "@/lib/dashboard-utils";
import { withBase } from "@/lib/createStackFetch";
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
  // Severity and confidence both come from DB columns now (severity from the
  // real column, confidence_score computed via json_extract in the SELECT).
  // We only JSON.parse the report for rootCause, which isn't promoted yet.
  const severity = inv.severity ?? "";
  const confidenceDisplay = normalizeConfidence(inv.confidence_score ?? undefined);
  let rootCause = "";
  if (inv.report) {
    try {
      const r = JSON.parse(inv.report);
      rootCause = r.rootCause ?? "";
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

  const statusBorder =
    inv.status === "complete"
      ? "border-l-success/60"
      : inv.status === "failed"
        ? "border-l-destructive/60"
        : "border-l-accent/60";

  const severityTint =
    severity === "critical" ? "bg-destructive/4" :
    severity === "high" ? "bg-accent/4" :
    "";

  const totalTokens = (inv.total_input_tokens ?? 0) + (inv.total_output_tokens ?? 0);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === "Enter") {
      onClick(inv.id);
    }
  };

  return (
    <a
      href={withBase(`/investigations/${inv.id}`)}
      tabIndex={0}
      onClick={(e) => { e.preventDefault(); onClick(inv.id); }}
      onKeyDown={handleKeyDown}
      className={cn(
        "group block cursor-pointer rounded-lg border border-border/40 border-l-[3px] hover:bg-card/70 hover:border-t-primary/25 hover:border-r-primary/25 hover:border-b-primary/25 px-4 py-3 transition-all card-lift no-underline",
        severityTint || "bg-card/40",
        statusBorder,
        className,
      )}
    >
      {/* Line 1: dot + service + severity + (right-aligned) confidence + tokens + duration.
          `flex-wrap` so the metrics drop below the service name on very narrow
          viewports (<~360px) rather than overflow. */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`flex-shrink-0 w-2 h-2 rounded-full ${statusColor} ${inv.status !== "running" ? "ring-2 ring-current/15" : ""}`} />
          <span className="font-body text-sm font-medium text-foreground/90 group-hover:text-foreground transition-colors truncate">
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
          {(() => {
            // Trigger source badge — tells the operator at a glance whether
            // this investigation came from the proactive scanner, an alert
            // webhook, or a human asking a question. "user" is the common
            // case, so we hide that label to avoid noise; scan/alert show.
            const source = inferTriggerSource(inv.query);
            if (source === "user") return null;
            return (
              <span
                className="flex-shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/55 px-1.5 h-4 leading-4 rounded border border-border/35"
                title={source === "scan" ? "Triggered by proactive scan" : "Triggered by alert webhook"}
              >
                {source}
              </span>
            );
          })()}
        </div>

        {/* Right-aligned metrics. Progressive disclosure by viewport:
            - <lg (1024px): hide tokens only. Confidence is the most
              operator-useful metric and fits in the space. Duration + age
              stay so the row always tells you "when + how long + how sure".
            - The metrics block itself is flex-wrap so at very narrow widths
              it breaks below the service name instead of overflowing. */}
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {confidenceDisplay && (
            <span className={cn(
              "font-mono text-[10px]",
              (() => {
                let num = parseFloat(confidenceDisplay);
                if (isNaN(num)) return "text-foreground/75";
                if (num > 0 && num <= 1) num *= 100;
                if (num >= 80) return "text-success";
                if (num >= 60) return "text-warning";
                return "text-destructive/80";
              })()
            )}>
              {confidenceDisplay}
            </span>
          )}
          {totalTokens > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground/50 hidden lg:inline">
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
        <p className="text-xs text-muted-foreground/70 truncate pl-3.5 mt-0.5 font-body">
          {rootCause}
        </p>
      )}
    </a>
  );
});

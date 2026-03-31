import type { ReactNode } from "react";
import type { AISummary, SectionStatus } from "../../types/service-brief.js";

interface ServiceBriefProps {
  summary: AISummary | null;
  sectionStatus: SectionStatus;
}

function formatRelativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function BriefShell({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border/25 bg-card/40 overflow-hidden border-l-2 border-l-primary/70">
      {children}
    </div>
  );
}

function BriefBody({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-4">
      {children}
    </div>
  );
}

export function ServiceBrief({ summary, sectionStatus }: ServiceBriefProps) {
  const { status, fetchedAt } = sectionStatus;

  // Error state
  if (status === "error") {
    return (
      <BriefShell>
        <BriefBody>
          <p className="text-[14px] font-body leading-[1.7] text-muted-foreground/60 italic">
            AI analysis unavailable.
          </p>
        </BriefBody>
      </BriefShell>
    );
  }

  // Unconfigured state
  if (status === "unconfigured") {
    return (
      <BriefShell>
        <BriefBody>
          <p className="text-[14px] font-body leading-[1.7] text-muted-foreground/60 italic">
            Configure an LLM provider to enable AI analysis.
          </p>
        </BriefBody>
      </BriefShell>
    );
  }

  // Null summary: LLM returned nothing
  if (summary === null) {
    return (
      <BriefShell>
        <BriefBody>
          <p className="text-[14px] font-body leading-[1.7] text-muted-foreground/60 italic">
            No analysis available.
          </p>
        </BriefBody>
      </BriefShell>
    );
  }

  // Data state (ok or stale, summary present)
  return (
    <BriefShell>
      <BriefBody>
        <p className="text-[14px] font-body leading-[1.7] text-foreground/90">
          {summary.text}
        </p>

        {/* Evidence refs */}
        {summary.evidenceRefs && summary.evidenceRefs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {summary.evidenceRefs.map((ref) => (
              <span
                key={ref}
                className="text-[10px] font-mono text-primary/70 bg-primary/6 border border-primary/15 rounded px-1.5 py-0.5"
              >
                {ref}
              </span>
            ))}
          </div>
        )}

        {/* Footer row: freshness + AI-generated label */}
        <div className="mt-3 flex items-center justify-between">
          <div>
            {fetchedAt !== undefined && (
              <span
                className={`text-[10px] font-mono ${
                  status === "stale"
                    ? "text-warning"
                    : "text-muted-foreground/50"
                }`}
              >
                Updated {formatRelativeTime(fetchedAt)}
              </span>
            )}
          </div>
          <span className="text-[10px] font-body text-muted-foreground/40 italic">
            AI-generated
          </span>
        </div>
      </BriefBody>
    </BriefShell>
  );
}

/** Standalone loading placeholder — use when the section fetch is in-flight. */
export function ServiceBriefSkeleton() {
  return (
    <div className="rounded-lg border border-border/25 bg-card/40 overflow-hidden border-l-2 border-l-primary/70">
      <div className="h-20 shimmer-skeleton" />
    </div>
  );
}

import { Badge } from "@/components/ui/badge";
import { type ReactNode } from "react";
import { FileText } from "lucide-react";
import { renderInline } from "../lib/renderInline";

interface RcaReportData {
  rootCause: string;
  trigger: string;
  confidence: string;
  confidenceScore?: number;
  severity: string;
  summary: string;
  impact: { duration: string; description: string };
  contributingFactors: string[];
  timeline: { time: string; event: string }[];
  recommendedActions: string[];
  dashboardLinks: string[];
  skillsUsed?: string[];
  timeRange?: { from: string; to: string };
  /** Hypothesis-loop output (Step 2). Unset on the single-pass path. */
  ruledOut?: { hypothesis: string; reason: string }[];
  loopOutcome?: "confirmed" | "undetermined" | "exhausted";
  /** Deep-mode re-examination (Step 3). Set only when deep mode was triggered. */
  deepMode?: {
    reexamined: { hypothesis: string; priorVerdict: string; deepVerdict: string; resurrected: boolean }[];
    resurrected: { hypothesis: string }[];
    outcome: "resurrected-candidate" | "rule-outs-confirmed" | "nothing-to-examine";
    examinedAt?: string;
  };
}

/** Human-readable gloss for a deterministic rule-out verdict. */
function ruleOutReason(reason: string): string {
  if (reason === "contradicted") return "evidence contradicted it";
  if (reason === "absent") return "no supporting evidence found";
  return reason;
}

/** Format a time range as human-readable local time. */
function formatTimeRange(from: string, to: string): string {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) return `${from} → ${to}`;

  const sameDay = fromDate.toDateString() === toDate.toDateString();
  const dateOpts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  const timeOpts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

  if (sameDay) {
    return `${fromDate.toLocaleDateString(undefined, dateOpts)}, ${fromDate.toLocaleTimeString(undefined, timeOpts)} → ${toDate.toLocaleTimeString(undefined, timeOpts)}`;
  }
  const fullOpts: Intl.DateTimeFormatOptions = { ...dateOpts, hour: "numeric", minute: "2-digit" };
  return `${fromDate.toLocaleString(undefined, fullOpts)} → ${toDate.toLocaleString(undefined, fullOpts)}`;
}

/** Strip leading number prefixes from action text.
 *  Handles: "1.", "1)", "**1.**", "1️⃣", keycap emoji (digit+VS16+U+20E3),
 *  and keycap emoji embedded inside bold markers like "**1️⃣ Text**" */
function stripLeadingNumber(text: string): string {
  // Remove all keycap emoji anywhere in the text (digit + optional VS16 + combining enclosing keycap)
  let cleaned = text.replace(/[\d][\uFE0F]?[\u20E3]/g, "");
  // Strip leading bold-wrapped or plain number prefixes: "**1.**", "1.", "1)"
  cleaned = cleaned.replace(/^\s*\*{0,2}\d+[.\)]\*{0,2}\s*/, "");
  // Clean up any leftover leading whitespace or empty bold markers
  cleaned = cleaned.replace(/^\s*\*\*\s*/, "**");
  return cleaned.trim();
}

function severityColor(severity: string): string {
  switch (severity) {
    case "critical": return "destructive";
    case "high": return "warning";
    case "medium": return "info";
    case "low": return "secondary";
    default: return "outline";
  }
}

function SectionLabel({ children, color = "text-accent" }: { children: ReactNode; color?: string }) {
  return (
    <h4 className={`text-xs font-mono font-semibold uppercase tracking-[0.1em] ${color} mb-1.5`}>
      {children}
    </h4>
  );
}

function Section({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-mono font-semibold uppercase tracking-[0.1em] text-accent mb-2">
        {label}{count != null ? ` (${count})` : ""}
      </h4>
      {children}
    </div>
  );
}

export function RcaReport({ report, hideOldDashboardLinks }: { report: RcaReportData; hideOldDashboardLinks?: boolean }) {

  const severityGlow =
    report.severity === "critical" ? "glow-red border-destructive/30" :
    report.severity === "high" ? "glow-coral border-accent/25" :
    "border-primary/20 glow-teal";

  return (
    <div className={`rounded-xl border ${severityGlow} bg-card/50 overflow-hidden animate-fade-up noise relative`}>
      {/* Severity stripe */}
      <div className={`h-[3px] ${report.severity === "critical" ? "bg-destructive" : report.severity === "high" ? "bg-accent" : "bg-primary/60"}`} />
      {/* Header */}
      <div className="px-5 py-4 border-b border-border/30">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg font-extrabold tracking-tight text-foreground">
            Root Cause Analysis
          </h3>
          <div className="flex gap-1.5 items-center">
            <Badge variant={severityColor(report.severity) as any} className="text-[9px] uppercase tracking-[0.1em]">
              {report.severity}
            </Badge>
            <span className="text-[9px] font-mono text-muted-foreground">
              {report.confidence}{report.confidenceScore != null ? ` (${report.confidenceScore.toFixed(2)})` : ""} confidence
            </span>
          </div>
        </div>
        {report.timeRange && (
          <div className="text-[10px] font-mono text-muted-foreground mt-1.5">
            Investigated: <time dateTime={report.timeRange.from}>{formatTimeRange(report.timeRange.from, report.timeRange.to)}</time>
          </div>
        )}
        {report.summary && (
          <p className="text-xs font-body text-muted-foreground leading-relaxed mt-2">
            {renderInline(report.summary)}
          </p>
        )}
      </div>

      {/* Error banner — LLM/infrastructure failure (distinct from low confidence) */}
      {report.confidenceScore === 0 && (
        <div className="px-5 py-2.5 bg-destructive/10 border-b border-destructive/20 flex items-center gap-2">
          <span className="text-destructive text-sm">✕</span>
          <span className="text-[11px] font-body text-destructive/80">Investigation could not run — LLM API is unreachable. Check Settings &gt; Health.</span>
        </div>
      )}
      {/* Low confidence banner */}
      {report.confidenceScore != null && report.confidenceScore > 0 && report.confidenceScore < 0.5 && (
        <div className="px-5 py-2.5 bg-warning/8 border-b border-warning/15 flex items-center gap-2">
          <span className="text-warning text-sm">⚠</span>
          <span className="text-[11px] font-body text-warning/80">Low confidence — insufficient data to determine root cause</span>
        </div>
      )}

      {/* Body — unified body font size (13px) across every section. */}
      <div className="px-5 py-4 space-y-4">
        {/* Root Cause, Trigger, Impact — aligned as a uniform list */}
        <div className="space-y-4">
          <div>
            <SectionLabel color="text-primary">Root Cause</SectionLabel>
            <p className={`text-[13px] font-body leading-relaxed ${report.confidenceScore != null && report.confidenceScore < 0.5 ? "text-foreground/50 italic" : "text-foreground/90"}`}>{renderInline(report.rootCause)}</p>
          </div>

          <div>
            <SectionLabel color="text-accent">Trigger</SectionLabel>
            <p className="text-[13px] font-body text-foreground/85 leading-relaxed">{renderInline(report.trigger)}</p>
          </div>

          <div>
            <SectionLabel>Impact</SectionLabel>
            <p className="text-[13px] font-body text-foreground/85 leading-relaxed">{renderInline(report.impact.description)}</p>
            <span className="text-[10px] font-mono text-muted-foreground mt-1 inline-block">
              Duration: {report.impact.duration}
            </span>
          </div>
        </div>

        {/* Timeline */}
        {report.timeline.length > 0 && (
          <Section label="Timeline" count={report.timeline.length}>
            <div className="border-l-2 border-primary/20 pl-4 space-y-2.5 ml-1">
              {report.timeline.map((evt, i) => (
                <div key={i} className="flex items-start gap-2.5 animate-fade-up" style={{ animationDelay: `${i * 0.04}s` }}>
                  <span className="text-[10px] font-mono text-primary/70 whitespace-nowrap mt-[3px]">{evt.time}</span>
                  <span className="text-[13px] font-body text-foreground/75 leading-relaxed">{renderInline(evt.event)}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Contributing Factors */}
        {report.contributingFactors.length > 0 && (
          <Section label="Contributing Factors" count={report.contributingFactors.length}>
            <ul className="space-y-1.5 ml-1">
              {report.contributingFactors.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] font-body text-foreground/75 leading-relaxed">
                  <span className="text-accent mt-0.5 shrink-0">&bull;</span>
                  <span>{renderInline(stripLeadingNumber(f))}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Ruled Out — the hypothesis loop's falsification receipts (Step 2).
            The symmetric negative of contributing factors: alternatives tested
            and demoted, each with the deterministic verdict that demoted it. */}
        {report.ruledOut && report.ruledOut.length > 0 && (
          <Section label="Ruled Out" count={report.ruledOut.length}>
            <ul className="space-y-1.5 ml-1">
              {report.ruledOut.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] font-body leading-relaxed">
                  <span className="text-destructive/70 mt-0.5 shrink-0 font-mono text-[11px]">&times;</span>
                  <span>
                    <span className="text-muted-foreground line-through decoration-muted-foreground/40">{renderInline(r.hypothesis)}</span>
                    <span className="text-muted-foreground/80"> — {ruleOutReason(r.reason)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Undetermined outcome — two hypotheses the evidence couldn't separate.
            Honest signal: don't imply a confirmed cause. */}
        {report.loopOutcome === "undetermined" && (
          <div className="px-3 py-2 rounded-md bg-warning/8 border border-warning/15">
            <span className="text-[11px] font-body text-warning/80">
              Multiple causes remained consistent with the evidence — none could be distinguished. Consider a deeper investigation.
            </span>
          </div>
        )}

        {/* Deep Mode (Step 3) — skeptical re-examination of the ruled-out causes.
            Either a dismissed cause came back (resurrected-candidate, surfaced
            prominently) or the rule-outs held (confirmation, raises trust). */}
        {report.deepMode && report.deepMode.outcome !== "nothing-to-examine" && (
          <Section label="Deep Mode" count={report.deepMode.reexamined.length}>
            {report.deepMode.outcome === "resurrected-candidate" ? (
              <div className="px-3 py-2 mb-2 rounded-md bg-warning/10 border border-warning/20">
                <span className="text-[11px] font-body text-warning/90">
                  Deeper evidence brought back {report.deepMode.resurrected.length} ruled-out{" "}
                  {report.deepMode.resurrected.length === 1 ? "cause" : "causes"} — the original conclusion may be incomplete.
                </span>
              </div>
            ) : (
              <div className="px-3 py-2 mb-2 rounded-md bg-success/8 border border-success/15">
                <span className="text-[11px] font-body text-success/80">
                  Deeper evidence held: none of the ruled-out causes came back. The original conclusion stands.
                </span>
              </div>
            )}
            <ul className="space-y-1.5 ml-1">
              {report.deepMode.reexamined.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] font-body leading-relaxed">
                  <span className={`mt-0.5 shrink-0 font-mono text-[11px] ${r.resurrected ? "text-warning/80" : "text-muted-foreground/60"}`}>
                    {r.resurrected ? "↑" : "·"}
                  </span>
                  <span>
                    <span className={r.resurrected ? "text-foreground" : "text-muted-foreground"}>{renderInline(r.hypothesis)}</span>
                    <span className="text-muted-foreground/80">
                      {" "}— {r.resurrected ? "resurrected: deeper evidence now supports it" : `still ${ruleOutReason(r.deepVerdict)}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Recommended Actions — renderInline (not renderMarkdown) so every item
            is a uniform single-line body paragraph. Actions from the LLM can
            contain stray heading markers (##, ###) which previously rendered
            as font-display uppercase blocks, creating visual size drift. */}
        {report.recommendedActions.length > 0 && (
          <Section label="Recommended Actions" count={report.recommendedActions.length}>
            <ol className="space-y-2 ml-1">
              {report.recommendedActions.map((a, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-[13px] font-body text-foreground/85 leading-relaxed animate-fade-up"
                  style={{ animationDelay: `${i * 0.04}s` }}
                >
                  <span className="text-[10px] font-mono text-primary/70 shrink-0 mt-[3px] tabular-nums">{i + 1}.</span>
                  <span className="min-w-0 flex-1">{renderInline(stripLeadingNumber(a))}</span>
                </li>
              ))}
            </ol>
          </Section>
        )}

        {/* Skills Used */}
        {report.skillsUsed && report.skillsUsed.length > 0 && (
          <div className="pt-3 border-t border-border/20">
            <h4 className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-2">
              Skills Used
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {report.skillsUsed.map((skill, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded-full bg-primary/8 text-primary/70 border border-primary/15">
                  <FileText size={9} className="!size-auto" />
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Legacy dashboard links — hidden when new evidence-level deep links are available */}
        {report.dashboardLinks.length > 0 && !hideOldDashboardLinks && (
          <div className="pt-3 border-t border-border/20">
            <h4 className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-2">
              Dashboards
            </h4>
            <div className="flex flex-wrap gap-2">
              {report.dashboardLinks.map((link, i) => (
                <a key={i} href={link} target="_blank" rel="noopener noreferrer" className="text-[11px] font-mono text-primary hover:text-primary/80 transition-colors underline underline-offset-2 decoration-primary/30 hover:decoration-primary/60">
                  Dashboard {i + 1}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useState, type ReactNode } from "react";
import { renderInline } from "../lib/renderInline";
import { renderMarkdown } from "../lib/renderMarkdown";

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
    case "high": return "default";
    default: return "secondary";
  }
}

function SectionLabel({ children, color = "text-foreground/70" }: { children: ReactNode; color?: string }) {
  return (
    <h4 className={`text-xs font-display font-bold uppercase tracking-[0.08em] ${color} mb-1.5`}>
      {children}
    </h4>
  );
}

function CollapsibleSection({ id, label, count, open, toggle, children }: { id: string; label: string; count: number; open: boolean; toggle: () => void; children: ReactNode }) {
  return (
    <Collapsible open={open} onOpenChange={toggle}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-display font-bold uppercase tracking-[0.08em] text-foreground/70 hover:text-foreground transition-colors cursor-pointer">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`}>
          <path d="M8 5l8 7-8 7z"/>
        </svg>
        {label} ({count})
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2.5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function RcaReport({ report }: { report: RcaReportData }) {
  const [open, setOpen] = useState<Set<string>>(new Set(["timeline", "factors", "actions"]));
  const toggle = (s: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n; });

  const severityGlow =
    report.severity === "critical" ? "glow-red border-destructive/30" :
    report.severity === "high" ? "glow-coral border-accent/25" :
    "border-primary/20 glow-teal";

  return (
    <div className={`rounded-xl border ${severityGlow} bg-card/50 overflow-hidden animate-fade-up`}>
      {/* Header */}
      <div className="px-5 py-4 border-b border-border/30">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-base font-bold tracking-tight text-foreground">
            Root Cause Analysis
          </h3>
          <div className="flex gap-1.5 items-center">
            <Badge variant={severityColor(report.severity) as any} className="text-[9px] uppercase tracking-wider">
              {report.severity}
            </Badge>
            <span className="text-[9px] font-mono text-muted-foreground">
              {report.confidence}{report.confidenceScore != null ? ` (${report.confidenceScore.toFixed(2)})` : ""} confidence
            </span>
          </div>
        </div>
        {report.summary && (
          <p className="text-xs font-body text-muted-foreground leading-relaxed mt-2">
            {renderInline(report.summary)}
          </p>
        )}
      </div>

      {/* Low confidence banner */}
      {report.confidenceScore != null && report.confidenceScore < 0.5 && (
        <div className="px-5 py-2.5 bg-warning/8 border-b border-warning/15 flex items-center gap-2">
          <span className="text-warning text-sm">⚠</span>
          <span className="text-[11px] font-body text-warning/80">Low confidence — insufficient data to determine root cause</span>
        </div>
      )}

      {/* Body */}
      <div className="px-5 py-4 space-y-4">
        {/* Root Cause, Trigger, Impact — aligned as a uniform list */}
        <div className="space-y-4">
          <div>
            <SectionLabel color="text-primary">Root Cause</SectionLabel>
            <p className={`text-sm font-body leading-relaxed ${report.confidenceScore != null && report.confidenceScore < 0.5 ? "text-foreground/50 italic" : "text-foreground/90"}`}>{renderInline(report.rootCause)}</p>
          </div>

          <div>
            <SectionLabel color="text-accent">Trigger</SectionLabel>
            <p className="text-sm font-body text-foreground/85 leading-relaxed">{renderInline(report.trigger)}</p>
          </div>

          <div>
            <SectionLabel>Impact</SectionLabel>
            <p className="text-sm font-body text-foreground/85 leading-relaxed">{renderInline(report.impact.description)}</p>
            <span className="text-[10px] font-mono text-muted-foreground mt-1 inline-block">
              Duration: {report.impact.duration}
            </span>
          </div>
        </div>

        {/* Timeline */}
        {report.timeline.length > 0 && (
          <CollapsibleSection id="timeline" label="Timeline" count={report.timeline.length} open={open.has("timeline")} toggle={() => toggle("timeline")}>
            <div className="border-l-2 border-primary/20 pl-4 space-y-2.5 ml-1">
              {report.timeline.map((evt, i) => (
                <div key={i} className="flex items-start gap-2.5 animate-fade-up" style={{ animationDelay: `${i * 0.04}s` }}>
                  <span className="text-[10px] font-mono text-primary/70 whitespace-nowrap mt-0.5">{evt.time}</span>
                  <span className="text-xs font-body text-foreground/75">{renderInline(evt.event)}</span>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Contributing Factors */}
        {report.contributingFactors.length > 0 && (
          <CollapsibleSection id="factors" label="Contributing Factors" count={report.contributingFactors.length} open={open.has("factors")} toggle={() => toggle("factors")}>
            <ul className="space-y-1.5 ml-1">
              {report.contributingFactors.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-xs font-body text-foreground/75">
                  <span className="text-accent mt-0.5 shrink-0">&bull;</span>
                  <span>{renderInline(stripLeadingNumber(f))}</span>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}

        {/* Recommended Actions */}
        {report.recommendedActions.length > 0 && (
          <CollapsibleSection id="actions" label="Recommended Actions" count={report.recommendedActions.length} open={open.has("actions")} toggle={() => toggle("actions")}>
            <div className="space-y-4 ml-1">
              {report.recommendedActions.map((a, i) => (
                <div key={i} className="text-xs font-body animate-fade-up" style={{ animationDelay: `${i * 0.04}s` }}>
                  <div className="flex items-start gap-2">
                    <span className="text-[10px] font-mono text-primary/70 shrink-0 mt-px">{i + 1}.</span>
                    <div className="leading-relaxed min-w-0 flex-1">{renderMarkdown(stripLeadingNumber(a))}</div>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Skills Used */}
        {report.skillsUsed && report.skillsUsed.length > 0 && (
          <div className="pt-3 border-t border-border/20">
            <h4 className="text-[10px] font-display font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-2">
              Skills Used
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {report.skillsUsed.map((skill, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded-full bg-primary/8 text-primary/70 border border-primary/15">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>
                  </svg>
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Grafana Links */}
        {report.dashboardLinks.length > 0 && (
          <div className="pt-3 border-t border-border/20">
            <h4 className="text-[10px] font-display font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-2">
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

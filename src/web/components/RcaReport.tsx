import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useState } from "react";

interface RcaReportData {
  rootCause: string;
  trigger: string;
  confidence: string;
  severity: string;
  summary: string;
  impact: { duration: string; description: string };
  contributingFactors: string[];
  timeline: { time: string; event: string }[];
  recommendedActions: string[];
  dashboardLinks: string[];
}

export function RcaReport({ report }: { report: RcaReportData }) {
  const [open, setOpen] = useState<Set<string>>(new Set(["timeline", "actions"]));
  const toggle = (s: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n; });

  const severityGlow = report.severity === "critical" ? "glow-red border-destructive/40" : "border-primary/30 glow-cyan";

  return (
    <div className={`rounded-xl border-2 ${severityGlow} bg-card/50 overflow-hidden animate-fade-up`}>
      {/* Header */}
      <div className="px-5 py-4 border-b border-border/30">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-base font-bold tracking-tight text-foreground/90">
            Root Cause Analysis
          </h3>
          <div className="flex gap-2">
            <Badge variant={report.severity === "critical" ? "destructive" : "default"} className="text-[10px]">
              {report.severity}
            </Badge>
            <Badge variant="outline" className="text-[10px] border-border/40 text-muted-foreground/60">
              {report.confidence} confidence
            </Badge>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-5">
        {/* Root Cause */}
        <div>
          <h4 className="text-[10px] font-display font-semibold uppercase tracking-[0.15em] text-primary/60 mb-1.5">
            Root Cause
          </h4>
          <p className="text-sm font-body text-foreground/80 leading-relaxed">{report.rootCause}</p>
        </div>

        {/* Trigger */}
        <div>
          <h4 className="text-[10px] font-display font-semibold uppercase tracking-[0.15em] text-accent/60 mb-1.5">
            Trigger
          </h4>
          <p className="text-sm font-body text-foreground/70 leading-relaxed">{report.trigger}</p>
        </div>

        {/* Impact */}
        <div className="rounded-lg bg-secondary/30 border border-border/20 px-3.5 py-2.5">
          <h4 className="text-[10px] font-display font-semibold uppercase tracking-[0.15em] text-muted-foreground/50 mb-1">
            Impact
          </h4>
          <p className="text-sm font-body text-foreground/70">{report.impact.description}</p>
          <span className="text-[11px] font-mono text-muted-foreground/40 mt-0.5 inline-block">Duration: {report.impact.duration}</span>
        </div>

        {/* Timeline */}
        <Collapsible open={open.has("timeline")} onOpenChange={() => toggle("timeline")}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] font-display font-semibold uppercase tracking-wide text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors cursor-pointer">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className={`transition-transform duration-200 ${open.has("timeline") ? "rotate-90" : ""}`}>
              <path d="M8 5l8 7-8 7z"/>
            </svg>
            Timeline ({report.timeline.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2.5">
            <div className="border-l border-primary/20 pl-4 space-y-2.5 ml-1">
              {report.timeline.map((evt, i) => (
                <div key={i} className="flex items-start gap-2.5 animate-fade-up" style={{ animationDelay: `${i * 0.04}s` }}>
                  <span className="text-[10px] font-mono text-primary/50 whitespace-nowrap mt-0.5">{evt.time}</span>
                  <span className="text-xs font-body text-foreground/60">{evt.event}</span>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Contributing Factors */}
        {report.contributingFactors.length > 0 && (
          <Collapsible open={open.has("factors")} onOpenChange={() => toggle("factors")}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] font-display font-semibold uppercase tracking-wide text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors cursor-pointer">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className={`transition-transform duration-200 ${open.has("factors") ? "rotate-90" : ""}`}>
                <path d="M8 5l8 7-8 7z"/>
              </svg>
              Contributing Factors ({report.contributingFactors.length})
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2.5">
              <ul className="space-y-1.5 ml-1">
                {report.contributingFactors.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs font-body text-foreground/60">
                    <span className="text-accent/50 mt-0.5">&bull;</span>{f}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Recommended Actions */}
        <Collapsible open={open.has("actions")} onOpenChange={() => toggle("actions")}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] font-display font-semibold uppercase tracking-wide text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors cursor-pointer">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className={`transition-transform duration-200 ${open.has("actions") ? "rotate-90" : ""}`}>
              <path d="M8 5l8 7-8 7z"/>
            </svg>
            Recommended Actions ({report.recommendedActions.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2.5">
            <ul className="space-y-2 ml-1">
              {report.recommendedActions.map((a, i) => (
                <li key={i} className="flex items-start gap-2.5 text-xs font-body text-foreground/60 animate-fade-up" style={{ animationDelay: `${i * 0.04}s` }}>
                  <span className="w-4 h-4 rounded border border-primary/30 flex items-center justify-center text-[9px] text-primary/40 shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  {a}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>

        {/* Grafana Links */}
        {report.dashboardLinks.length > 0 && (
          <div className="pt-2 border-t border-border/20">
            <h4 className="text-[10px] font-display font-semibold uppercase tracking-[0.15em] text-muted-foreground/40 mb-2">
              Dashboards
            </h4>
            <div className="flex flex-wrap gap-2">
              {report.dashboardLinks.map((link, i) => (
                <a key={i} href={link} target="_blank" rel="noopener noreferrer" className="text-[11px] font-mono text-primary/60 hover:text-primary transition-colors underline underline-offset-2 decoration-primary/20 hover:decoration-primary/50">
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

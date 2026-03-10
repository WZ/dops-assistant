import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useState, type ReactNode } from "react";

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

/** Parse inline markdown: **bold**, *italic*, `code` into JSX spans */
function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={match.index} className="font-semibold text-foreground">{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={match.index} className="italic">{match[3]}</em>);
    } else if (match[4]) {
      parts.push(<code key={match.index} className="px-1 py-0.5 rounded bg-secondary/50 text-[0.9em] font-mono text-foreground/80">{match[4]}</code>);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

/** Render block-level markdown (headings, code blocks, tables, lists, hr, paragraphs) */
function renderMarkdown(md: string): ReactNode {
  const lines = md.split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === "") { i++; continue; }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim())) {
      nodes.push(<hr key={k++} className="border-border/30 my-3" />);
      i++; continue;
    }

    // Headings
    const hm = line.match(/^(#{1,4})\s+(.+)/);
    if (hm) {
      const cls = hm[1].length <= 2
        ? "text-xs font-display font-bold uppercase tracking-[0.08em] text-foreground/80 mt-3 mb-1.5"
        : "text-xs font-display font-semibold text-foreground/70 mt-2.5 mb-1";
      nodes.push(<div key={k++} className={cls}>{renderInline(hm[2])}</div>);
      i++; continue;
    }

    // Fenced code block
    if (line.trim().startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      nodes.push(
        <pre key={k++} className="my-2 px-3 py-2 rounded-md bg-secondary/40 border border-border/30 overflow-x-auto text-[11px] font-mono text-foreground/80 leading-relaxed">
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Table (line has | and next line is separator)
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s\-:|]+\|/.test(lines[i + 1])) {
      const tLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) {
        tLines.push(lines[i]);
        i++;
      }
      const parseRow = (row: string) => row.split("|").map(c => c.trim()).filter(c => c !== "");
      const header = parseRow(tLines[0]);
      const body = tLines.slice(2).map(parseRow);
      nodes.push(
        <div key={k++} className="my-2 overflow-x-auto rounded-md border border-border/30">
          <table className="w-full text-[11px] font-body">
            <thead>
              <tr className="bg-secondary/30">
                {header.map((h, ci) => (
                  <th key={ci} className="px-2.5 py-1.5 text-left font-semibold text-foreground/70 border-b border-border/30 whitespace-nowrap">
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 0 ? "" : "bg-secondary/15"}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-2.5 py-1.5 text-foreground/75 border-b border-border/20">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      nodes.push(
        <ul key={k++} className="my-1.5 space-y-1 ml-1">
          {items.map((item, ii) => (
            <li key={ii} className="flex items-start gap-2 text-foreground/75">
              <span className="text-accent mt-0.5 shrink-0">&bull;</span>
              <span className="leading-relaxed">{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      nodes.push(
        <ol key={k++} className="my-1.5 space-y-1 ml-1">
          {items.map((item, ii) => (
            <li key={ii} className="flex items-start gap-2 text-foreground/75">
              <span className="text-[10px] font-mono text-primary/70 shrink-0 mt-px">{ii + 1}.</span>
              <span className="leading-relaxed">{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Paragraph (default)
    nodes.push(<p key={k++} className="text-foreground/75 leading-relaxed my-1">{renderInline(line)}</p>);
    i++;
  }

  return <>{nodes}</>;
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
  const [open, setOpen] = useState<Set<string>>(new Set(["timeline", "actions"]));
  const toggle = (s: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n; });

  const severityGlow =
    report.severity === "critical" ? "glow-red border-destructive/30" :
    report.severity === "high" ? "glow-amber border-accent/25" :
    "border-primary/20 glow-cyan";

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
              {report.confidence} confidence
            </span>
          </div>
        </div>
        {report.summary && (
          <p className="text-xs font-body text-muted-foreground leading-relaxed mt-2">
            {renderInline(report.summary)}
          </p>
        )}
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-4">
        {/* Root Cause, Trigger, Impact — aligned as a uniform list */}
        <div className="space-y-4">
          <div>
            <SectionLabel color="text-primary">Root Cause</SectionLabel>
            <p className="text-sm font-body text-foreground/90 leading-relaxed">{renderInline(report.rootCause)}</p>
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

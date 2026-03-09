import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  return (
    <Card className="border-2">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Root Cause Analysis</CardTitle>
          <div className="flex gap-2">
            <Badge variant={report.severity === "critical" ? "destructive" : "default"}>{report.severity}</Badge>
            <Badge variant="outline">{report.confidence} confidence</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold mb-1">Root Cause</h3>
          <p className="text-sm">{report.rootCause}</p>
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-1">Trigger</h3>
          <p className="text-sm">{report.trigger}</p>
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-1">Impact</h3>
          <p className="text-sm">{report.impact.description} ({report.impact.duration})</p>
        </div>

        <Collapsible open={open.has("timeline")} onOpenChange={() => toggle("timeline")}>
          <CollapsibleTrigger className="text-sm font-semibold cursor-pointer hover:underline">
            {open.has("timeline") ? "\u25BE" : "\u25B8"} Timeline ({report.timeline.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="border-l-2 border-muted-foreground/20 pl-4 space-y-2">
              {report.timeline.map((evt, i) => (
                <div key={i} className="text-xs">
                  <span className="font-mono text-muted-foreground">{evt.time}</span>
                  <span className="ml-2">{evt.event}</span>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {report.contributingFactors.length > 0 && (
          <Collapsible open={open.has("factors")} onOpenChange={() => toggle("factors")}>
            <CollapsibleTrigger className="text-sm font-semibold cursor-pointer hover:underline">
              {open.has("factors") ? "\u25BE" : "\u25B8"} Contributing Factors ({report.contributingFactors.length})
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <ul className="list-disc list-inside text-sm space-y-1">
                {report.contributingFactors.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}

        <Collapsible open={open.has("actions")} onOpenChange={() => toggle("actions")}>
          <CollapsibleTrigger className="text-sm font-semibold cursor-pointer hover:underline">
            {open.has("actions") ? "\u25BE" : "\u25B8"} Recommended Actions ({report.recommendedActions.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <ul className="space-y-1">
              {report.recommendedActions.map((a, i) => (
                <li key={i} className="text-sm flex items-start gap-2">
                  <span className="text-muted-foreground">{"\u25A1"}</span>{a}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>

        {report.dashboardLinks.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold mb-1">Grafana Dashboards</h3>
            <div className="flex flex-wrap gap-2">
              {report.dashboardLinks.map((link, i) => (
                <a key={i} href={link} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">
                  Dashboard {i + 1}
                </a>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

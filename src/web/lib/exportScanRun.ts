/**
 * Export helpers for the Scan Run detail view. Mirrors exportInvestigation.ts
 * (link copy, markdown copy, PNG download) but formats scan-run data:
 * run metadata + list of dispatched investigations.
 */
import { toPng } from "html-to-image";

export interface ScanRunSummaryShape {
  id: string;
  /** Stack that owns this run + its investigations. Threaded into the
   *  Markdown investigation links so pasting them into Slack/docs lands the
   *  reader on the canonical stack-scoped URL. */
  stackId: string;
  trigger: "manual" | "cron";
  status: "running" | "complete" | "failed" | "skipped";
  startedAt: number;
  servicesProbed: number;
  hitsDispatched: number;
  durationMs: number | null;
}

export interface ScanRunInvestigationShape {
  investigationId: string;
  service: string;
  ruleName: string;
  status: string;
  reportSummary: string | null;
}

export function scanRunToMarkdown(
  run: ScanRunSummaryShape,
  investigations: ScanRunInvestigationShape[],
): string {
  const lines: string[] = [];
  lines.push(`# Scan Run ${run.id}`);
  lines.push("");
  lines.push(`- **Started:** ${new Date(run.startedAt).toISOString()}`);
  lines.push(`- **Trigger:** ${run.trigger}`);
  lines.push(`- **Status:** ${run.status}`);
  lines.push(`- **Services probed:** ${run.servicesProbed}`);
  lines.push(`- **Investigations dispatched:** ${run.hitsDispatched}`);
  if (run.durationMs != null) lines.push(`- **Duration:** ${run.durationMs}ms`);
  lines.push("");
  if (investigations.length === 0) {
    lines.push("No investigations dispatched.");
  } else {
    lines.push("## Dispatched investigations");
    for (const inv of investigations) {
      lines.push(
        `- **${inv.service}** (${inv.ruleName}) — ${inv.status} · [${inv.investigationId}](/stacks/${run.stackId}/investigations/${inv.investigationId})`,
      );
      if (inv.reportSummary) lines.push(`  - _${inv.reportSummary}_`);
    }
  }
  return lines.join("\n");
}

export function copyLink(): Promise<void> {
  return navigator.clipboard.writeText(window.location.href);
}

export function copyMarkdown(
  run: ScanRunSummaryShape,
  investigations: ScanRunInvestigationShape[],
): Promise<void> {
  return navigator.clipboard.writeText(scanRunToMarkdown(run, investigations));
}

export async function downloadPng(node: HTMLElement, runId: string): Promise<void> {
  const png = await toPng(node, { pixelRatio: 2 });
  const a = document.createElement("a");
  a.href = png;
  a.download = `scan-run-${runId}-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Format an RCA report as clean Markdown for clipboard copy.
 * Suitable for pasting into Jira, Slack post-incident review, or Confluence.
 */

import type { RcaReport } from "../../types/rca-types.js";

export function formatRcaMarkdown(report: RcaReport): string {
  const lines: string[] = [];

  lines.push(`# RCA Report: ${report.service}`);
  lines.push("");
  lines.push(`**Severity:** ${report.severity} | **Confidence:** ${report.confidence} (${Math.round(report.confidenceScore * 100)}%)`);
  lines.push(`**Investigated:** ${report.investigatedAt}`);
  lines.push("");

  lines.push("## Summary");
  lines.push(report.summary);
  lines.push("");

  lines.push("## Root Cause");
  lines.push(report.rootCause);
  lines.push("");

  lines.push("## Trigger");
  lines.push(report.trigger);
  lines.push("");

  if (report.impact) {
    lines.push("## Impact");
    lines.push(`${report.impact.description} (Duration: ${report.impact.duration})`);
    lines.push("");
  }

  if (report.timeline?.length) {
    lines.push("## Timeline");
    for (const event of report.timeline) {
      lines.push(`- **${event.time}** — ${event.event}`);
    }
    lines.push("");
  }

  if (report.contributingFactors?.length) {
    lines.push("## Contributing Factors");
    for (const factor of report.contributingFactors) {
      lines.push(`- ${factor}`);
    }
    lines.push("");
  }

  if (report.evidence) {
    lines.push("## Evidence");
    if (report.evidence.metrics?.length) {
      lines.push("### Metrics");
      for (const m of report.evidence.metrics) lines.push(`- ${m}`);
    }
    if (report.evidence.logs?.length) {
      lines.push("### Logs");
      for (const l of report.evidence.logs) lines.push(`- ${l}`);
    }
    if (report.evidence.infra?.length) {
      lines.push("### Infrastructure");
      for (const i of report.evidence.infra) lines.push(`- ${i}`);
    }
    if (report.evidence.changes?.length) {
      lines.push("### Recent Changes");
      for (const c of report.evidence.changes) lines.push(`- ${c}`);
    }
    lines.push("");
  }

  if (report.recommendedActions?.length) {
    lines.push("## Recommended Actions");
    report.recommendedActions.forEach((action, i) => {
      lines.push(`${i + 1}. ${action}`);
    });
    lines.push("");
  }

  if (report.dashboardLinks?.length) {
    lines.push("## Dashboard Links");
    for (const link of report.dashboardLinks) lines.push(`- ${link}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

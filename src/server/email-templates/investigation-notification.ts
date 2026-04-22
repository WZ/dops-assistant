/**
 * Email templates for completed investigations.
 * Pure functions — no I/O. Inline styles only (Teams email-to-channel friendly).
 */

import type { RcaReport } from "../../types/rca-types.js";
import { type NotificationSource, sourceDisplayText } from "../../types/notifications.js";

export const SEVERITY_COLORS: Record<RcaReport["severity"], string> = {
  critical: "#b91c1c",
  high: "#c2410c",
  medium: "#a16207",
  low: "#0369a1",
};

const MAX_SUBJECT_LEN = 80;
const MAX_SUMMARY_IN_SUBJECT = 60;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateAtWordBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

function safeInvestigationId(id: string): string {
  return SAFE_ID_RE.test(id) ? id : "unknown";
}

/**
 * The rest of the codebase stores confidenceScore as a 0–1 float (see
 * `normalizeConfidence` in `src/web/lib/dashboard-utils.ts`), but historical
 * fixtures sometimes use 0–100. Accept both: values ≤1 are treated as fraction,
 * values >1 as percentage. Output is always 0–100 rounded to integer.
 */
function formatConfidencePct(raw: number | undefined | null): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
}

function formatInvestigatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function formatWindow(tr: { from: string; to: string } | undefined): string | undefined {
  if (!tr) return undefined;
  const a = new Date(tr.from);
  const b = new Date(tr.to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${tr.from} → ${tr.to}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `${hm(a)}–${hm(b)} UTC`;
}

function stripHeaderUnsafe(s: string): string {
  // SMTP header injection defense: CR/LF in a header value lets an attacker
  // append forged headers. Also strip NULs and other C0 controls.
  return s.replace(/[\r\n\x00-\x1F\x7F]+/g, " ").trim();
}

export function renderSubject(report: RcaReport): string {
  const sevTag = `[${(report.severity ?? "unknown").toUpperCase()}]`;
  const summary = truncateAtWordBoundary(report.summary ?? "", MAX_SUMMARY_IN_SUBJECT);
  const raw = stripHeaderUnsafe(`${sevTag} ${report.service ?? "unknown"}: ${summary}`);
  return raw.length <= MAX_SUBJECT_LEN ? raw : truncateAtWordBoundary(raw, MAX_SUBJECT_LEN);
}

export function renderBody(
  report: RcaReport,
  investigationId: string,
  appBaseUrl: string,
  source: NotificationSource,
): string {
  const color = SEVERITY_COLORS[report.severity] ?? "#374151";
  const sevTag = escapeHtml(report.severity.toUpperCase());
  const svc = escapeHtml(report.service);
  const investigatedAt = escapeHtml(formatInvestigatedAt(report.investigatedAt));
  const win = formatWindow(report.timeRange);
  const src = escapeHtml(sourceDisplayText(source));
  const investigationUrl = joinUrl(appBaseUrl, `investigations/${safeInvestigationId(investigationId)}`);

  const bannerSubline = [
    `Investigated ${investigatedAt}`,
    win ? `Window ${escapeHtml(win)}` : undefined,
    `Detected by: ${src}`,
  ].filter(Boolean).join(" · ");

  const li = (items: string[]): string =>
    items.length === 0 ? "" : `<ul style="margin: 4px 0 12px 20px; padding: 0;">${items.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;

  const ol = (items: string[]): string =>
    items.length === 0 ? "" : `<ol style="margin: 4px 0 12px 20px; padding: 0;">${items.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>`;

  const linkList = (items: string[]): string =>
    items.length === 0 ? "" : `<ul style="margin: 4px 0 12px 20px; padding: 0;">${items.map((x) => {
      const safe = escapeHtml(x);
      // Only permit http(s) URLs as hrefs. Anything else (javascript:, data:, etc.) renders as a neutralized "#".
      const href = /^https?:\/\//i.test(x) ? safe : "#";
      return `<li><a href="${href}" style="color: #0369a1;">${safe}</a></li>`;
    }).join("")}</ul>`;

  const timelineRows = report.timeline.map((t) => `
    <tr>
      <td style="padding: 4px 12px 4px 0; vertical-align: top; white-space: nowrap; font-family: monospace;">${escapeHtml(t.time)}</td>
      <td style="padding: 4px 0;">${escapeHtml(t.event)}</td>
    </tr>
  `).join("");

  const changesBlock = report.evidence.changes && report.evidence.changes.length > 0
    ? `<h3 style="margin: 8px 0 4px; font-size: 14px;">Changes</h3>${li(report.evidence.changes)}`
    : "";

  const skillsFooter = report.skillsUsed && report.skillsUsed.length > 0
    ? `<p style="margin-top: 24px; color: #6b7280; font-size: 12px;">Skills used: ${escapeHtml(report.skillsUsed.join(", "))}</p>`
    : "";

  return `<!doctype html>
<html><body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827;">
<div style="max-width: 680px; margin: 0 auto; padding: 16px;">

  <div style="background-color: ${color}; color: #ffffff; padding: 16px 20px; border-radius: 6px;">
    <div style="font-size: 18px; font-weight: 600;">[${sevTag}] ${svc}</div>
    <div style="font-size: 12px; margin-top: 4px; opacity: 0.92;">${bannerSubline}</div>
  </div>

  <h2 style="margin: 20px 0 6px; font-size: 16px;">Summary</h2>
  <p style="margin: 0 0 12px;">${escapeHtml(report.summary)}</p>

  <h2 style="margin: 16px 0 6px; font-size: 16px;">Impact</h2>
  <p style="margin: 0;">${escapeHtml(report.impact.description)}</p>
  <p style="margin: 4px 0 12px; color: #4b5563;"><strong>Duration:</strong> ${escapeHtml(report.impact.duration)}</p>

  <h2 style="margin: 16px 0 6px; font-size: 16px;">Trigger</h2>
  <p style="margin: 0 0 12px;">${escapeHtml(report.trigger)}</p>

  <h2 style="margin: 16px 0 6px; font-size: 16px;">Root cause</h2>
  <p style="margin: 0;">${escapeHtml(report.rootCause)}</p>
  <p style="margin: 4px 0 12px; color: #4b5563;"><strong>Confidence:</strong> ${escapeHtml(report.confidence)} (${formatConfidencePct(report.confidenceScore)} / 100)</p>

  <h2 style="margin: 16px 0 6px; font-size: 16px;">Contributing factors</h2>
  ${li(report.contributingFactors)}

  <h2 style="margin: 16px 0 6px; font-size: 16px;">Timeline</h2>
  <table style="border-collapse: collapse; margin-bottom: 12px;">${timelineRows}</table>

  <h2 style="margin: 16px 0 6px; font-size: 16px;">Evidence</h2>
  <h3 style="margin: 8px 0 4px; font-size: 14px;">Metrics</h3>${li(report.evidence.metrics)}
  <h3 style="margin: 8px 0 4px; font-size: 14px;">Logs</h3>${li(report.evidence.logs)}
  <h3 style="margin: 8px 0 4px; font-size: 14px;">Infrastructure</h3>${li(report.evidence.infra)}
  ${changesBlock}

  <h2 style="margin: 16px 0 6px; font-size: 16px;">Recommended actions</h2>
  ${ol(report.recommendedActions)}

  <h2 style="margin: 16px 0 6px; font-size: 16px;">Dashboards</h2>
  ${linkList(report.dashboardLinks)}

  <p style="margin: 20px 0;"><a href="${escapeHtml(investigationUrl)}" style="color: #ffffff; background-color: #111827; padding: 10px 16px; text-decoration: none; border-radius: 4px; display: inline-block;">Open investigation in DOps Assistant →</a></p>

  ${skillsFooter}
</div>
</body></html>`;
}

export function renderTextFallback(
  report: RcaReport,
  investigationId: string,
  appBaseUrl: string,
  source: NotificationSource,
): string {
  const lines: string[] = [];
  lines.push(`[${report.severity.toUpperCase()}] ${report.service}`);
  lines.push(`Investigated ${formatInvestigatedAt(report.investigatedAt)}`);
  const win = formatWindow(report.timeRange);
  if (win) lines.push(`Window ${win}`);
  lines.push(`Detected by: ${sourceDisplayText(source)}`);
  lines.push("");
  lines.push("SUMMARY");
  lines.push(report.summary);
  lines.push("");
  lines.push("IMPACT");
  lines.push(report.impact.description);
  lines.push(`Duration: ${report.impact.duration}`);
  lines.push("");
  lines.push("TRIGGER");
  lines.push(report.trigger);
  lines.push("");
  lines.push("ROOT CAUSE");
  lines.push(report.rootCause);
  lines.push(`Confidence: ${report.confidence} (${formatConfidencePct(report.confidenceScore)} / 100)`);
  lines.push("");
  if (report.contributingFactors.length > 0) {
    lines.push("CONTRIBUTING FACTORS");
    for (const f of report.contributingFactors) lines.push(`  • ${f}`);
    lines.push("");
  }
  if (report.timeline.length > 0) {
    lines.push("TIMELINE");
    for (const t of report.timeline) lines.push(`  ${t.time}  ${t.event}`);
    lines.push("");
  }
  lines.push("EVIDENCE");
  if (report.evidence.metrics.length > 0) { lines.push("  Metrics:"); for (const x of report.evidence.metrics) lines.push(`    • ${x}`); }
  if (report.evidence.logs.length > 0) { lines.push("  Logs:"); for (const x of report.evidence.logs) lines.push(`    • ${x}`); }
  if (report.evidence.infra.length > 0) { lines.push("  Infrastructure:"); for (const x of report.evidence.infra) lines.push(`    • ${x}`); }
  if (report.evidence.changes && report.evidence.changes.length > 0) {
    lines.push("  Changes:");
    for (const x of report.evidence.changes) lines.push(`    • ${x}`);
  }
  lines.push("");
  if (report.recommendedActions.length > 0) {
    lines.push("RECOMMENDED ACTIONS");
    report.recommendedActions.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
    lines.push("");
  }
  if (report.dashboardLinks.length > 0) {
    lines.push("DASHBOARDS");
    for (const d of report.dashboardLinks) lines.push(`  • ${d}`);
    lines.push("");
  }
  lines.push(`Open investigation: ${joinUrl(appBaseUrl, `investigations/${safeInvestigationId(investigationId)}`)}`);
  if (report.skillsUsed && report.skillsUsed.length > 0) {
    lines.push("");
    lines.push(`Skills used: ${report.skillsUsed.join(", ")}`);
  }
  return lines.join("\n");
}

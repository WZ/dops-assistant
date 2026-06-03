/**
 * SlackNotifier — sends investigation completion notifications to a Slack
 * incoming webhook URL. No Slack SDK dependency — just a fetch POST.
 */

import { createLogger } from "../logger.js";
import type { RcaReport } from "../types/rca-types.js";
import { confidencePercent } from "../lib/confidence.js";

const logger = createLogger();

/** One-time warn flag — operators get a single nudge per process when
 *  Slack is configured but the app base URL isn't, instead of a warning per
 *  notification. Module-level so all paths (notifySlack and the scan-run
 *  helpers) share the same dedup, and so future callers can't accidentally
 *  re-introduce different policies (the prior design defaulted half the
 *  paths to `localhost:3000`, which produced misleading-but-clickable
 *  links). Tests can call `__resetAppBaseUrlWarn()` to reset between cases. */
let warnedMissingAppBaseUrl = false;

/** Test hook — reset the one-time warn flag so test cases that exercise
 *  the missing-config branch don't depend on execution order. Not part of
 *  the public API. */
export function __resetAppBaseUrlWarn(): void {
  warnedMissingAppBaseUrl = false;
}

/** Centralizes the "Slack configured but appBaseUrl unset" policy: warn
 *  once, then return undefined so the caller omits the link. Every Slack
 *  path (investigation-complete, scan-run auto, scan-run manual) goes
 *  through this so the policy stays consistent.
 *
 *  Trimming happens before the falsy check so empty/whitespace-only
 *  values from cleared GUI inputs (db.getSetting can return "") behave
 *  identically to undefined — otherwise an operator who wipes the field
 *  in a settings UI would get an emit-only-`/scan/runs/...` URL with no
 *  origin, which is worse than no link. */
function resolveAppBaseUrl(appBaseUrl: string | undefined): string | undefined {
  const trimmed = appBaseUrl?.trim();
  if (trimmed) return trimmed.replace(/\/$/, "");
  if (!warnedMissingAppBaseUrl) {
    warnedMissingAppBaseUrl = true;
    logger.warn(
      "Slack notifications enabled but notifications.email.appBaseUrl is unset — links will be omitted from Slack posts. Set this field to surface clickable links.",
    );
  }
  return undefined;
}

export interface SlackNotifierOptions {
  /** Slack incoming webhook URL */
  slackWebhookUrl: string;
  /** Base URL of the dops-assistant SPA, used to build the "View
   *  Investigation" deep link. Pre-stack-scoped versions of this notifier
   *  shipped this as `grafanaUrl` and emitted a hash-routed URL
   *  (`${url}/#/investigations/...`) — but the SPA uses pushState, not hash
   *  routing, so the link landed on the Grafana homepage and the hash was
   *  ignored. Drop the link when this isn't configured rather than
   *  pretending. */
  appBaseUrl?: string;
  /** Owning stack of the investigation. Threaded into the canonical
   *  `/stacks/:stackId/investigations/:id` URL. Optional so the test
   *  notification path (which has no real investigation) still renders. */
  stackId?: string;
}

/**
 * Send a Slack notification for a completed investigation.
 *
 * Non-blocking — logs errors but never throws so it doesn't disrupt
 * the investigation completion flow.
 */
export async function notifySlack(
  opts: SlackNotifierOptions,
  investigationId: string,
  service: string,
  report: RcaReport,
): Promise<void> {
  const { slackWebhookUrl, appBaseUrl, stackId } = opts;

  const severity = report.severity ?? "unknown";
  const confidence = report.confidenceScore != null
    ? `${confidencePercent(report.confidenceScore)}%`
    : "N/A";
  const rootCause = report.rootCause ?? "Unable to determine";
  const summary = report.summary ?? "";

  const severityEmoji: Record<string, string> = {
    critical: ":red_circle:",
    high: ":large_orange_circle:",
    medium: ":large_yellow_circle:",
    low: ":large_green_circle:",
  };
  const emoji = severityEmoji[severity] ?? ":white_circle:";

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${service} — Investigation Complete`, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Severity:*\n${emoji} ${severity}` },
        { type: "mrkdwn", text: `*Confidence:*\n${confidence}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Root Cause:*\n${rootCause.slice(0, 500)}` },
    },
  ];

  if (summary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Summary:*\n${summary.slice(0, 500)}` },
    });
  }

  const base = resolveAppBaseUrl(appBaseUrl);
  if (base) {
    const path = stackId
      ? `/stacks/${encodeURIComponent(stackId)}/investigations/${encodeURIComponent(investigationId)}`
      : `/investigations/${encodeURIComponent(investigationId)}`;
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Investigation" },
          url: `${base}${path}`,
        },
      ],
    });
  }

  const payload = { blocks };

  try {
    const res = await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "Slack webhook returned non-OK status");
    } else {
      logger.info({ investigationId, service }, "Slack notification sent");
    }
  } catch (err) {
    logger.error({ err, investigationId, service }, "Failed to send Slack notification");
  }
}

export interface NotifySlackScanRunOptions {
  /** Slack incoming webhook URL */
  slackWebhookUrl: string;
  /** Base URL of the dops-assistant SPA, used to build the
   *  /scan/runs/:id deep link. Optional — when unset, the scan-run post
   *  drops the "View run" hyperlink and just shows the metrics in the
   *  context block. Matches the policy used by the investigation-complete
   *  path (notifySlack); see resolveAppBaseUrl above. */
  appBaseUrl?: string;
}

export interface ScanRunSummary {
  runId: string;
  stackId: string;
  trigger: "manual" | "cron";
  startedAt: number;
  durationMs: number;
  servicesProbed: number;
  hitsDispatched: number;
  dispatchedServices: string[];
}

/**
 * Post a run-level scan summary to Slack. Builds the Block Kit payload and
 * does the fetch — THROWS on fetch or non-OK response so callers that need
 * to surface errors (e.g., a user-initiated "Send to Slack" action) can.
 *
 * For the automatic scan-complete path that must never disrupt the scan
 * flow, use `notifySlackOnScanComplete` which wraps + swallows errors.
 */
export async function sendSlackScanRunPost(
  opts: NotifySlackScanRunOptions,
  summary: ScanRunSummary,
): Promise<void> {
  const base = resolveAppBaseUrl(opts.appBaseUrl);
  const emoji = summary.hitsDispatched > 0 ? ":mag:" : ":white_check_mark:";
  const pluralS = summary.hitsDispatched === 1 ? "" : "s";
  const text = summary.hitsDispatched > 0
    ? `${emoji} Scan flagged ${summary.hitsDispatched} service${pluralS} (${summary.trigger})`
    : `${emoji} Scan completed clean (${summary.trigger}, ${summary.servicesProbed} probed)`;

  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text } },
  ];
  if (summary.dispatchedServices.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Flagged:*\n" + summary.dispatchedServices.map(s => `• ${s}`).join("\n") },
    });
  }
  // Drop the "View run" hyperlink when appBaseUrl isn't configured rather
  // than emit a localhost:3000 link the operator can't actually click.
  // The metrics tail (probed count + duration) stays either way.
  const metricsTail = `${summary.servicesProbed} probed · ${Math.round(summary.durationMs)}ms`;
  const contextText = base
    ? `<${base}/scan/runs/${encodeURIComponent(summary.runId)}|View run> · ${metricsTail}`
    : metricsTail;
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: contextText },
    ],
  });

  const resp = await fetch(opts.slackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });
  if (!resp.ok) {
    throw new Error(`Slack post failed: ${resp.status}`);
  }
}

/**
 * Post a run-level scan summary to Slack. Called once per scan run (not per
 * dispatched investigation — those fire via the existing notifySlack path).
 * Fire-and-forget, never throws.
 */
export async function notifySlackOnScanComplete(
  opts: NotifySlackScanRunOptions,
  summary: ScanRunSummary,
): Promise<void> {
  try {
    await sendSlackScanRunPost(opts, summary);
  } catch (err) {
    logger.warn({ err, runId: summary.runId }, "notifySlackOnScanComplete: post failed");
  }
}

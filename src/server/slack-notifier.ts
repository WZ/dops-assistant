/**
 * SlackNotifier — sends investigation completion notifications to a Slack
 * incoming webhook URL. No Slack SDK dependency — just a fetch POST.
 */

import { createLogger } from "../logger.js";
import type { RcaReport } from "../types/rca-types.js";

const logger = createLogger();

export interface SlackNotifierOptions {
  /** Slack incoming webhook URL */
  slackWebhookUrl: string;
  /** Optional Grafana base URL for linking to investigations */
  grafanaUrl?: string;
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
  const { slackWebhookUrl, grafanaUrl } = opts;

  const severity = report.severity ?? "unknown";
  const confidence = report.confidenceScore != null
    ? `${Math.round(report.confidenceScore * 100)}%`
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

  if (grafanaUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Investigation" },
          url: `${grafanaUrl.replace(/\/$/, "")}/#/investigations/${investigationId}`,
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

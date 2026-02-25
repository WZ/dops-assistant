import type { KnownBlock } from "@slack/bolt";
import { withRetry } from "../utils/retry.js";

export type AnomalyAlert = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  affectedMetrics?: string[];
  dashboardUrl?: string;
  recommendedAction?: string;
};

const SEVERITY_EMOJI: Record<AnomalyAlert["severity"], string> = {
  low: ":yellow_circle:",
  medium: ":orange_circle:",
  high: ":red_circle:",
  critical: ":rotating_light:",
};

export async function sendAnomalyAlert(
  webhookUrl: string,
  alert: AnomalyAlert,
): Promise<void> {
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${SEVERITY_EMOJI[alert.severity]} Anomaly detected: ${alert.service}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Service:*\n${alert.service}` },
        { type: "mrkdwn", text: `*Severity:*\n${alert.severity}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Summary:*\n${alert.summary}` },
    },
  ];

  if (alert.recommendedAction) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recommended action:*\n${alert.recommendedAction}`,
      },
    });
  }

  if (alert.affectedMetrics && alert.affectedMetrics.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Affected metrics:*\n${alert.affectedMetrics.map((m) => `• ${m}`).join("\n")}`,
      },
    });
  }

  if (alert.dashboardUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "view_dashboard",
          text: { type: "plain_text", text: "View Dashboard" },
          url: alert.dashboardUrl,
        },
      ],
    });
  }

  await withRetry(
    async () => {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks }),
      });
      if (!response.ok) {
        const err = Object.assign(
          new Error(`Slack webhook failed: ${response.status} ${response.statusText}`),
          { status: response.status },
        );
        throw err;
      }
    },
    { maxAttempts: 3, baseDelayMs: 500 },
  );
}

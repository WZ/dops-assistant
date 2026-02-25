import type { KnownBlock } from "@slack/bolt";

export type AnomalyAlert = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  metrics?: string[];
  affectedMetrics?: string[];
  recommendedAction?: string;
  dashboardUrl?: string;
};

const SEVERITY_EMOJI = {
  low: ":yellow_circle:",
  medium: ":orange_circle:",
  high: ":red_circle:",
  critical: ":rotating_light:",
};

export async function sendAnomalyAlert(webhookUrl: string, alert: AnomalyAlert): Promise<void> {
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

  const affectedMetrics = alert.affectedMetrics ?? alert.metrics;
  if (affectedMetrics && affectedMetrics.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Affected Metrics:*\n${affectedMetrics.map((m) => `• ${m}`).join("\n")}`,
      },
    });
  }

  if (alert.recommendedAction) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Recommended Action:*\n${alert.recommendedAction}` },
    });
  }

  if (alert.dashboardUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Dashboard" },
          url: alert.dashboardUrl,
        },
      ],
    });
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
  }
}

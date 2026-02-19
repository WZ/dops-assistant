import type { KnownBlock } from "@slack/bolt";

export type AnomalyAlert = {
  service: string;
  severity: "low" | "medium" | "high";
  summary: string;
  metrics?: string[];
  dashboardUrl?: string;
};

const SEVERITY_EMOJI = { low: ":yellow_circle:", medium: ":orange_circle:", high: ":red_circle:" };

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

  if (alert.metrics && alert.metrics.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Metrics:*\n${alert.metrics.map((m) => `• ${m}`).join("\n")}` },
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

import type { KnownBlock } from "@slack/bolt";
import type { RcaReport } from "../agent/rca-types.js";

const SEVERITY_EMOJI: Record<RcaReport["severity"], string> = {
  low: ":yellow_circle:",
  medium: ":orange_circle:",
  high: ":red_circle:",
  critical: ":rotating_light:",
};

const CONFIDENCE_LABEL: Record<RcaReport["confidence"], string> = {
  low: ":low_brightness: low",
  medium: ":medium_brightness: medium",
  high: ":high_brightness: high",
};

export function formatRcaBlocks(report: RcaReport): KnownBlock[] {
  const time = new Date(report.investigatedAt).toISOString().slice(11, 16) + " UTC";

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${SEVERITY_EMOJI[report.severity]} [${report.severity}] ${report.service} — ${report.summary}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Root Cause*\n${report.rootCause}` },
    },
  ];

  const evidenceLines: string[] = [];
  if (report.evidence.metrics.length > 0) {
    evidenceLines.push(`*Metrics*\n${report.evidence.metrics.map((m) => `• ${m}`).join("\n")}`);
  }
  if (report.evidence.logs.length > 0) {
    evidenceLines.push(`*Logs*\n${report.evidence.logs.map((l) => `• ${l}`).join("\n")}`);
  }
  if (report.evidence.infra.length > 0) {
    evidenceLines.push(`*Infrastructure*\n${report.evidence.infra.map((i) => `• ${i}`).join("\n")}`);
  }

  if (evidenceLines.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Evidence*\n${evidenceLines.join("\n\n")}` },
    });
  }

  if (report.recommendedActions.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recommended Actions*\n${report.recommendedActions.map((a, i) => `${i + 1}. ${a}`).join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Confidence: ${CONFIDENCE_LABEL[report.confidence]}  |  Investigated at ${time}`,
      },
    ],
  });

  return blocks;
}

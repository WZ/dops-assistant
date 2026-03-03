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

/** Strip leading bullet/number markers that the LLM may include in list items */
function stripLeadingBullet(s: string): string {
  let cleaned = s.trim();
  // Strip emoji numbers (1️⃣ through 🔟) — keycap sequences: digit + U+FE0F + U+20E3
  cleaned = cleaned.replace(/^[\u0030-\u0039]\uFE0F?\u20E3\s*/, "");
  // Strip leading "N." or "N)" numbering
  cleaned = cleaned.replace(/^\d+[.)]\s*/, "");
  // Strip bullet markers (•, -, *)
  cleaned = cleaned.replace(/^[•\-\*]\s*/, "");
  return cleaned.trim();
}

export function formatRcaBlocks(report: RcaReport): KnownBlock[] {
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
    evidenceLines.push(`*Metrics*\n${report.evidence.metrics.map((m) => `• ${stripLeadingBullet(m)}`).join("\n")}`);
  }
  if (report.evidence.logs.length > 0) {
    evidenceLines.push(`*Logs*\n${report.evidence.logs.map((l) => `• ${stripLeadingBullet(l)}`).join("\n")}`);
  }
  if (report.evidence.infra.length > 0) {
    evidenceLines.push(`*Infrastructure*\n${report.evidence.infra.map((i) => `• ${stripLeadingBullet(i)}`).join("\n")}`);
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
        text: `*Recommended Actions*\n${report.recommendedActions.map((a, i) => `${i + 1}. ${stripLeadingBullet(a)}`).join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Confidence: ${CONFIDENCE_LABEL[report.confidence]}  |  Investigated at ${report.investigatedAt}`,
      },
    ],
  });

  return blocks;
}

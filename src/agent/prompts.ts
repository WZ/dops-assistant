import type { ResponseFormat } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";

export function buildSystemPrompt(
  mode: "proactive" | "conversational",
  services?: ServiceConfig[],
): string {
  if (mode === "proactive") {
    return buildProactiveStructuredPrompt(services);
  }

  return `You are an ops assistant with access to Grafana monitoring data. Answer the user's question using the available tools.
- Be specific: include actual metric values, timestamps, and trends
- Link to dashboards when you find relevant ones
- When discussing metrics, use the get_panel_image tool to capture relevant Grafana panel screenshots. The images will be automatically sent to the user. Before calling get_panel_image, first use list_panels to get the correct panel IDs for the dashboard.
- NEVER include base64 image data or markdown image syntax (![...](data:...)) in your text response. The images are delivered separately.
- If you cannot find the data needed, say so clearly`;
}

export function buildProactiveStructuredPrompt(
  services?: ServiceConfig[],
): string {
  const serviceList = services
    ?.map((s) => {
      const metrics = s.metrics.length > 0
        ? s.metrics.map((m) => `  - ${m.description}: \`${m.query}\``).join("\n")
        : "  (no metrics configured)";
      const logs = Object.entries(s.logLabels ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return `Service: ${s.name}\nMetrics:\n${metrics}${logs ? `\nLog labels: {${logs}}` : ""}`;
    })
    .join("\n\n");

  return `You are an infrastructure monitoring agent. Check the following services for anomalies by querying Grafana.

For each service, use the available tools to query its metrics and recent logs. Look for:
- Unusually high or low request rates
- Elevated error rates or latency spikes
- Unusual log patterns or errors

After investigating, respond ONLY with a valid json object matching the required schema. Do not include any other text.

${serviceList || "No services configured."}`;
}

export const ANOMALY_ASSESSMENT_RESPONSE_FORMAT: ResponseFormat =
  {
    type: "json_schema",
    json_schema: {
      name: "anomaly_assessment",
      strict: true,
      schema: {
        type: "object",
        properties: {
          isAnomaly: { type: "boolean" },
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
          },
          summary: { type: "string" },
          affectedMetrics: { type: "array", items: { type: "string" } },
          recommendedAction: { type: "string" },
        },
        required: [
          "isAnomaly",
          "severity",
          "summary",
          "affectedMetrics",
          "recommendedAction",
        ],
        additionalProperties: false,
      },
    },
  };

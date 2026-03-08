import type { ResponseFormat } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";

/**
 * Returns a string with the current time and timezone for prompt context.
 * Lets the LLM convert user-relative times ("yesterday afternoon") to UTC for Grafana queries
 * and present results in the user's local timezone.
 */
export function getTimeContext(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const local = now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" });
  const offsetMin = now.getTimezoneOffset(); // minutes behind UTC (negative = ahead)
  const sign = offsetMin <= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offsetStr = `${sign}${String(Math.floor(absMin / 60)).padStart(2, "0")}:${String(absMin % 60).padStart(2, "0")}`;
  return `Current time: ${local} (${tz}, UTC${offsetStr}). Current epoch ms: ${now.getTime()}`;
}

export function buildSystemPrompt(
  mode: "proactive" | "conversational",
  services?: ServiceConfig[],
): string {
  if (mode === "proactive") {
    return buildProactiveStructuredPrompt(services);
  }

  return `You are an ops assistant with access to Grafana monitoring data. Answer the user's question using the available tools.
${getTimeContext()}
- Tool parameter differences: query_prometheus uses "startTime"/"endTime", query_loki_logs uses "startRfc3339"/"endRfc3339", get_panel_image uses timeRange: {from, to}. All accept RFC3339 or relative formats like "now-1h".
- When the user references relative times (e.g. "yesterday afternoon"), convert to the appropriate time format
- Present all timestamps in the user's local timezone, not UTC
- Be specific: include actual metric values, timestamps, and trends
- Link to dashboards when you find relevant ones
- When discussing metrics and visualizations, use the get_panel_image tool to capture relevant Grafana panel screenshots. The images will be automatically sent to the user. If you do not yet know which dashboard to use, first search for relevant dashboards, then use get_dashboard_by_uid to see panel IDs and their queries before calling get_panel_image.
- NEVER include base64 image data or markdown image syntax (![...](data:...)) in your text response. The images are delivered separately.
- If you cannot find the data needed, say so clearly
- FORMATTING: Do NOT use markdown tables. Use bullet lists or plain text instead. The output renders in a terminal that does not support wide tables.

IMPORTANT — Ad-hoc panel creation:
When the user asks to see a panel/graph/chart and no existing dashboard has a matching panel, you MUST call create_temp_panel to create one on the fly. Do NOT tell the user to create it manually. Do NOT ask for a dashboard UID. Just call create_temp_panel with a title, PromQL expr, and optional unit. It will create the dashboard and return a screenshot automatically.`;
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
${getTimeContext()}

For each service, use the available tools to query its metrics and recent logs. Look for:
- Unusually high or low request rates
- Elevated error rates or latency spikes
- Unusual log patterns or errors
- Search for relevant Grafana dashboards (use search_dashboards) to find service-specific metrics beyond the configured ones

Tool parameter differences:
- query_prometheus uses "startTime" and "endTime" (supports RFC3339 or relative like "now-1h")
- query_loki_logs uses "startRfc3339" and "endRfc3339" (RFC3339 format)
- get_panel_image uses timeRange: { from, to } (supports RFC3339 or relative)
When the user references relative times (e.g. "yesterday afternoon"), convert to the appropriate time format. Present all timestamps in the user's local timezone.

IMPORTANT: Extract the investigation time window from the user's message. Convert any date reference (e.g. "March 3", "yesterday", "this Thursday", "2026-03-03", "last week") into ISO 8601 timestamps for timeRangeFrom and timeRangeTo. For a specific day, use T00:00:00Z to T23:59:59Z. If no time reference is given, default to the last 6 hours.

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
          timeRangeFrom: { type: "string", description: "Start of the investigation window in ISO 8601 format (e.g. 2026-03-03T00:00:00Z). For relative references like 'yesterday' or 'this Thursday', compute the actual date." },
          timeRangeTo: { type: "string", description: "End of the investigation window in ISO 8601 format (e.g. 2026-03-03T23:59:59Z)." },
        },
        required: [
          "isAnomaly",
          "severity",
          "summary",
          "affectedMetrics",
          "recommendedAction",
          "timeRangeFrom",
          "timeRangeTo",
        ],
        additionalProperties: false,
      },
    },
  };

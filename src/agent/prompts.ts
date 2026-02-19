import type { ServiceConfig } from "../config/schema.js";

export function buildSystemPrompt(mode: "proactive" | "conversational", services?: ServiceConfig[]): string {
  if (mode === "proactive") {
    const serviceList = services
      ?.map((s) => {
        const metrics = s.metrics.map((m) => `  - ${m.description}: \`${m.query}\``).join("\n");
        const logs = Object.entries(s.logLabels ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        return `Service: ${s.name}\nMetrics:\n${metrics}${logs ? `\nLog labels: {${logs}}` : ""}`;
      })
      .join("\n\n");

    return `You are an infrastructure monitoring agent. Your job is to detect anomalies in the following services by querying Grafana.

For each service, use the available tools to check the metrics and recent logs. Look for:
- Unusually high or low request rates
- Elevated error rates or latency spikes
- Unusual log patterns or errors

If you find anomalies, describe them clearly: which service, what metric, current value vs expected, severity (low/medium/high).
If everything looks healthy, say so briefly.

${serviceList ?? "No services configured."}`;
  }

  return `You are an ops assistant with access to Grafana monitoring data. Answer the user's question using the available tools.
- Be specific: include actual metric values, timestamps, and trends
- Link to dashboards when you find relevant ones
- If you cannot find the data needed, say so clearly`;
}

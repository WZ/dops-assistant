import type { ResponseFormat } from "../llm/openai.js";
import type { DiscoveryConfig } from "../config/schema.js";

export const DISCOVERY_PROMPT = `You are a service discovery agent. Your job is to discover services monitored in this Grafana/Prometheus environment and generate configuration for each.

For each discovered service, produce:
- name: a short identifier (e.g. "payments-api", "user-service")
- metrics: an array of useful Prometheus queries with descriptions. Focus on RED signals:
  - Request rate (e.g. rate(http_requests_total{...}[5m]))
  - Error rate (e.g. rate(http_requests_total{status=~"5.."}[5m]))
  - Latency (e.g. histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{...}[5m])))
  Only include metrics that actually exist — verify by querying them.
- logLabels: key-value pairs for querying this service's logs in Loki. Try common label names (app, service, job) and verify which ones return results.

Strategy:
1. Query the consul metric to get a list of service names
2. For each service (excluding infrastructure services listed below):
   a. Use list_prometheus_metric_metadata or query_prometheus to find metrics matching the service name (try job label, service label, and other common patterns)
   b. Select the most useful RED metrics and write working PromQL queries
   c. Query Loki to find log labels that match this service
3. Return ALL discovered services as a JSON array

Important:
- Only include metrics you have verified exist by querying them
- Write complete, working PromQL queries (not templates)
- If a service has no discoverable metrics or logs, still include it with empty arrays — it can be enriched later

Respond ONLY with valid JSON matching the required schema.`;

export const DISCOVERED_SERVICES_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "discovered_services",
    strict: true,
    schema: {
      type: "object",
      properties: {
        services: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              metrics: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["query", "description"],
                  additionalProperties: false,
                },
              },
              logLabels: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
            required: ["name", "metrics", "logLabels"],
            additionalProperties: false,
          },
        },
      },
      required: ["services"],
      additionalProperties: false,
    },
  },
};

export function buildDiscoveryUserMessage(config: DiscoveryConfig): string {
  const parts = [
    `Discover services using the Prometheus metric: ${config.consulMetric}`,
    `Query: ${config.consulMetric} to find all service names.`,
  ];
  if (config.excludeServices.length > 0) {
    parts.push(`Exclude these infrastructure services: ${config.excludeServices.join(", ")}`);
  }
  return parts.join("\n");
}

import type { ResponseFormat } from "../llm/openai.js";
import type { DiscoveryConfig } from "../config/schema.js";

export const DISCOVERY_PROMPT = `You are a service discovery agent. Your job is to discover services from Consul and generate monitoring configuration.

For each discovered service, produce:
- name: the service_name from the consul metric
- metrics: 1 Prometheus query — the consul health metric for this service. Format: consul_catalog_service_node_healthy{service_name="<name>"}
- logLabels: {} (log label matching is handled automatically after discovery)

Strategy:
1. Call list_datasources to find the Prometheus datasource UID.
2. Query Prometheus to get ALL service names using a compact aggregation query:
   expr: count by (service_name) (<consul_metric>)
   queryType: instant
   This returns exactly one row per service name (not per node), keeping the result small.
   Extract every unique service_name value from the result.
3. Output the JSON with all discovered services.

For each service:
- metrics: always include consul_catalog_service_node_healthy{service_name="<name>"}
- logLabels: always set to {} (will be enriched later)

Important:
- Include EVERY unique service_name from the consul metric (except excluded ones)
- Keep metrics to exactly 1 query per service (the consul health metric)
- Do NOT query Loki — log label discovery is handled separately

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

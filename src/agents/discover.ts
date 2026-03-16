import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";

export interface DiscoverAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  excludeServices?: string[];
}

export function createDiscoverAgent(config: DiscoverAgentConfig) {
  const excludeList = config.excludeServices?.length
    ? `\n\nEXCLUDE these services from your results (case-insensitive): ${config.excludeServices.join(", ")}`
    : "";

  return new Agent({
    id: "discover",
    name: "discover",
    instructions: () => `You are a service discovery agent. Your job is to find all monitored services in the environment using the available tools.

## Process

1. First, explore the available tools to understand what monitoring systems are connected (metrics, logs, dashboards, etc.)
2. Use the tools to find a service catalog or registry. Common approaches:
   - Query a service health metric (e.g., consul_catalog_service_node_healthy, up, kube_pod_info)
   - List available dashboards and extract service names
   - Query label values for common service label keys
3. For each discovered service:
   - Find or construct a health/existence metric query that can verify the service is running
   - Find log label mappings — which log labels correspond to this service
4. Return ALL discovered services as a JSON array

## Output Format

Return a JSON array of service objects. Each object must have:
- "name": string — the service name
- "metrics": array of { "query": string, "description": string } — at minimum a health check query
- "logLabels": object — key-value pairs mapping log label names to values for this service (empty {} if unknown)

Example:
\`\`\`json
[
  {
    "name": "ingestion-server",
    "metrics": [{ "query": "consul_catalog_service_node_healthy{service_name=\\"ingestion-server\\"}", "description": "" }],
    "logLabels": { "app": "ingestion-server" }
  }
]
\`\`\`

Be thorough — discover ALL services, not just a sample. Return the complete list as valid JSON.${excludeList}`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 40,
    },
  });
}

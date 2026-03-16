import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { createQuirkPrepareStep } from "./shared/prepare-step.js";

export interface DiscoverAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  excludeServices?: string[];
  useQuirkHandling?: boolean;
}

export function createDiscoverAgent(config: DiscoverAgentConfig) {
  const excludeList = config.excludeServices?.length
    ? `\n\nEXCLUDE these services from your results (case-insensitive): ${config.excludeServices.join(", ")}`
    : "";

  return new Agent({
    id: "discover",
    name: "discover",
    instructions: () => `You are a service discovery agent. Your job is to find all monitored services using ONLY Prometheus metrics tools.

## IMPORTANT: Use Prometheus only — do NOT use Loki or log-related tools.

## Process

1. Find the Prometheus datasource using list_datasources
2. Query Prometheus to find a service catalog metric. Try these in order:
   - \`count by (service_name) (consul_catalog_service_node_healthy)\` — Consul service registry
   - \`count by (job) (up)\` — generic Prometheus targets
   - \`count by (app) (kube_pod_info)\` — Kubernetes pods
3. For each discovered service, construct a Prometheus health metric query
4. Return ALL discovered services as a JSON array

## Output Format

Return a JSON array. Each object must have:
- "name": string — the service name
- "metrics": array of { "query": string, "description": string } — a Prometheus health check query
- "logLabels": {} — always empty (log labels are populated separately)

Example:
\`\`\`json
[
  {
    "name": "ingestion-server",
    "metrics": [{ "query": "consul_catalog_service_node_healthy{service_name=\\"ingestion-server\\"}", "description": "Health check" }],
    "logLabels": {}
  }
]
\`\`\`

Be thorough — discover ALL services. Return valid JSON.${excludeList}`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 40,
      prepareStep: config.useQuirkHandling !== false
        ? createQuirkPrepareStep({ maxSteps: config.maxSteps ?? 40 })
        : undefined,
    },
  });
}

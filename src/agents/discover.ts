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
    instructions: () => `You are a service discovery agent. Your job is to find ALL monitored services — both application services AND infrastructure — using ONLY Prometheus metrics tools.

## IMPORTANT: Use Prometheus only — do NOT use Loki or log-related tools.

## Process

1. Find the Prometheus datasource using list_datasources
2. Run MULTIPLE discovery queries to build a comprehensive catalog. Do NOT stop at the first query — run several and merge the results:

   **Kubernetes workloads (finds application services):**
   - \`count by (deployment) (kube_deployment_status_replicas)\` — Deployments
   - \`count by (statefulset) (kube_statefulset_status_replicas)\` — StatefulSets
   - \`count by (daemonset) (kube_daemonset_status_desired_number_scheduled)\` — DaemonSets
   - \`count by (container) (kube_pod_container_info{container!="POD",container!=""})\` — containers

   **Pod labels (finds services by app label):**
   - \`count by (app) (kube_pod_info)\` — pods grouped by app label

   **Service registry (if available):**
   - \`count by (service_name) (consul_catalog_service_node_healthy)\` — Consul

   **Prometheus scrape targets (mostly infrastructure):**
   - \`count by (job) (up)\` — scrape target jobs

3. Merge results from all successful queries. Deduplicate — if the same service appears under different names (e.g., "faz-api-svr" as a deployment and as a container), keep one entry.
4. For each service, construct a Prometheus health/activity metric query using the metric that discovered it.
5. Return ALL discovered services as a JSON array.

## IMPORTANT: Don't miss application services
Kubernetes clusters have two categories of services:
- **Infrastructure**: kubelet, kube-proxy, coredns, apiserver, etcd — these show up in \`up\` metrics
- **Application**: your actual workloads (APIs, data processors, web servers) — these show up in kube_deployment, kube_statefulset, and container metrics

The \`count by (job) (up)\` query mostly returns infrastructure. You MUST also query kube_deployment and kube_statefulset metrics to find application services.

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
    "metrics": [{ "query": "kube_deployment_status_replicas{deployment=\\"ingestion-server\\"}", "description": "Deployment replicas" }],
    "logLabels": {}
  }
]
\`\`\`

Be thorough — discover ALL services. Return valid JSON.${excludeList}`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 40,
      modelSettings: { temperature: 0 },
      prepareStep: config.useQuirkHandling !== false
        ? createQuirkPrepareStep({ maxSteps: config.maxSteps ?? 40 })
        : undefined,
    },
  });
}

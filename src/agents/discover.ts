import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { createQuirkPrepareStep } from "./shared/prepare-step.js";

export interface DiscoverAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  excludeServices?: string[];
  useQuirkHandling?: boolean;
  discoveryRecipes?: string;
}

export function createDiscoverAgent(config: DiscoverAgentConfig) {
  const excludeList = config.excludeServices?.length
    ? `\n\nEXCLUDE these services from your results (case-insensitive): ${config.excludeServices.join(", ")}`
    : "";

  const recipeHints = config.discoveryRecipes
    ? `\n\n## Provider-Specific Discovery Hints

The following discovery recipes are configured for your monitoring stack. Use these as starting points:

${config.discoveryRecipes}

These are suggestions — also use your own discovery strategies based on available tools.`
    : "";

  return new Agent({
    id: "discover",
    name: "discover",
    instructions: () => `You are a service discovery agent. Your job is to find ALL monitored services — both application services AND infrastructure — using the available metric and service catalog tools.

## IMPORTANT: Use metric, infrastructure, and service catalog tools — do NOT use log search tools.

## Process

1. Examine your available tools. Look for metric query tools, infrastructure/Kubernetes tools, service listing tools, or catalog tools.
2. Run MULTIPLE discovery queries to build a comprehensive catalog. Do NOT stop at the first query — use several approaches and merge the results:

   **If infrastructure tools are available (e.g., Kubernetes API):**
   - List pods, namespaces, or deployments to discover running services directly
   - Infrastructure tools provide ground truth about what's actually running — use them first

   **If metric query tools are available:**
   - Query for workload metrics (deployments, statefulsets, containers) grouped by service/app name
   - Query for scrape targets or service health metrics
   - Look for service-level metrics that reveal application names

   **If service catalog/listing tools are available:**
   - Use them to enumerate all known services directly

3. Merge results from all successful queries. Deduplicate — if the same service appears under different names, keep one entry.
4. For each service, construct a health/activity metric query using the metric that discovered it.
5. Return ALL discovered services as a JSON array.${recipeHints}

## IMPORTANT: Don't miss application services
Monitoring systems typically track two categories:
- **Infrastructure**: system-level services (proxies, DNS, API servers, schedulers)
- **Application**: your actual workloads (APIs, data processors, web servers)

Infrastructure often dominates basic health check queries. Make sure to also discover application services by querying workload-specific metrics.

## Output Format

Return a JSON array. Each object must have:
- "name": string — the service name
- "metrics": array of { "query": string, "description": string } — a health check query for this service
- "logLabels": object — key/value pairs identifying this service in log systems.
  IMPORTANT: These must match actual Loki stream labels, NOT kube-state-metrics
  labels. Loki typically does NOT expose \`deployment\`/\`statefulset\`/\`daemonset\`
  labels. Prefer:
    - For a single deployment: {"container": "<service-name>"} or {"pod": "<service-name>"}
    - For a statefulset: {"container": "<service-name>"} (the container usually shares
      the workload name) — NOT {"statefulset": "..."}
    - For multiple pods under one app: {"app": "<app-label>"} or {"namespace": "...", "container": "..."}
  If an infrastructure tool reveals actual pod labels, container names, or namespace,
  use those. Use {} if no label info is available. A wrong label is worse than none —
  the logs agent will query Loki with it and get empty results.

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

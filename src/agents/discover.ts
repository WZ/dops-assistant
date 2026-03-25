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

## IMPORTANT: Use metric and service catalog tools only — do NOT use log search tools.

## Process

1. Examine your available tools. Look for metric query tools, service listing tools, or catalog tools.
2. Run MULTIPLE discovery queries to build a comprehensive catalog. Do NOT stop at the first query — use several approaches and merge the results:

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
- "logLabels": {} — always empty (log labels are populated separately)

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

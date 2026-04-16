import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { createQuirkPrepareStep } from "./shared/prepare-step.js";

export interface DiscoverAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  excludeServices?: string[];
  useQuirkHandling?: boolean;
  /** Datasource UIDs rendered as a strict non-negotiable block. */
  datasourceUidHints?: string;
  /** Recipe and skill hints rendered as suggestions. */
  discoveryRecipes?: string;
}

export function createDiscoverAgent(config: DiscoverAgentConfig) {
  const excludeList = config.excludeServices?.length
    ? `\n\nEXCLUDE these services from your results (case-insensitive): ${config.excludeServices.join(", ")}`
    : "";

  const datasourceBlock = config.datasourceUidHints
    ? `\n\n## CRITICAL: Datasource UIDs (non-negotiable)

When calling ANY Prometheus or Loki tool (query_prometheus, query_loki_logs,
list_loki_label_names, etc.), you MUST pass datasourceUid EXACTLY as listed
below. Do NOT guess, abbreviate, or use short names like "prometheus" or "loki".
Do NOT call list_datasources — these UIDs are already resolved for you.

${config.datasourceUidHints}`
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
   - List deployments or statefulsets first — they map 1:1 to services and are compact
   - AVOID listing all pods unfiltered — a cluster may have hundreds of pods and the
     raw output wastes your token budget. If you must list pods, use fieldSelector or
     labelSelector to exclude system namespaces (kube-system, kube-public, kube-node-lease)
     and filter to running pods only
   - Prefer metric queries (kube_deployment_status_replicas, kube_statefulset_status_replicas)
     over raw pod lists — metrics are pre-aggregated and much smaller

   **If metric query tools are available:**
   - Query for workload metrics (deployments, statefulsets, containers) grouped by service/app name
   - Query for scrape targets or service health metrics
   - Look for service-level metrics that reveal application names

   **If service catalog/listing tools are available:**
   - Use them to enumerate all known services directly

3. Merge results from all successful queries. Deduplicate — if the same service appears under different names, keep one entry.
4. For each service, construct a health/activity metric query using the metric that discovered it.
5. Return ALL discovered services as a JSON array.${datasourceBlock}${recipeHints}

## IMPORTANT: Don't miss application services
Monitoring systems typically track two categories:
- **Infrastructure**: system-level services (proxies, DNS, API servers, schedulers)
- **Application**: your actual workloads (APIs, data processors, web servers)

Infrastructure often dominates basic health check queries. Make sure to also discover application services by querying workload-specific metrics.

## Output Format

Return a JSON array. Each object must have:
- "name": string — the service name
- "metrics": array of { "query": string, "description": string } — a health check query for this service
- "logLabels": object — key/value pairs identifying this service in whatever log
  system is wired up (Loki, Elasticsearch, Splunk, CloudWatch, etc.). These must
  match the actual stream labels / index fields the log provider exposes — NOT
  the labels from metric systems like kube-state-metrics. A common mistake is
  copying \`deployment\`/\`statefulset\`/\`daemonset\` from Prometheus metrics when
  the log provider only indexes \`container\`/\`pod\`/\`namespace\`/\`app\`.

  HOW TO CHOOSE:
    1. If a log-listing or log-label-discovery tool is available (e.g.
       \`list_loki_label_names\`, \`list_indices\`, \`describe_log_groups\`), call it
       once up front and prefer labels that actually exist in the result.
    2. If an infrastructure tool reveals pod names, container names, app labels,
       or namespaces, use those.
    3. Otherwise fall back to the most widely-supported identifiers — \`container\`
       and \`pod\` tend to work across most k8s log pipelines; \`namespace\` +
       workload-name narrows ambiguous cases.
    4. For statefulsets and daemonsets specifically: the \`container\` name
       usually matches the workload name, while the kube-state-metrics label
       (\`statefulset\`/\`daemonset\`) almost never exists in logs.
    5. Use {} if no label info is available. A wrong label is worse than none —
       the logs agent will query with it and get empty results.

Be thorough — discover ALL services. Return valid JSON.

OUTPUT STRICTNESS: Return PURE JSON only. Do NOT include JavaScript-style
comments (// or /* */), trailing commas, or section headers inside the array.
If you want to group services conceptually, use an extra field like
"category": "deployment" | "statefulset" | "daemonset" | "container" on
the service object itself — do not use inline comments as dividers.${excludeList}`,
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

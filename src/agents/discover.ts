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

/**
 * Build the discovery agent's instruction prompt. Exported for unit testing
 * so prompt-content regressions (e.g. the bad-availability-metric trap that
 * shipped before 2026-04-25) surface as fast assertions instead of waiting
 * for a full discover-eval run.
 */
export function buildDiscoverInstructions(config: DiscoverAgentConfig): string {
  const excludeList = config.excludeServices?.length
    ? `\n\nEXCLUDE these services from your results (case-insensitive): ${config.excludeServices.join(", ")}`
    : "";

  const datasourceBlock = config.datasourceUidHints
    ? `\n\n## CRITICAL: Datasource UIDs (non-negotiable)

When calling ANY metric or log query tool that requires a datasourceUid parameter,
you MUST pass datasourceUid EXACTLY as listed below. Do NOT guess, abbreviate,
or use short names like "prometheus" or "loki". Do NOT call datasource listing
tools — these UIDs are already resolved for you.

${config.datasourceUidHints}`
    : "";

  const recipeHints = config.discoveryRecipes
    ? `\n\n## Provider-Specific Discovery Hints

The following discovery recipes are configured for your monitoring stack. Use these as starting points:

${config.discoveryRecipes}

These are suggestions — also use your own discovery strategies based on available tools.`
    : "";

  return `You are a service discovery agent. Your job is to find ALL monitored services — both application services AND infrastructure — using the available metric and service catalog tools.

## IMPORTANT: Use metric, infrastructure, and service catalog tools — do NOT use log search tools.

## Process

1. Examine your available tools. Look for metric query tools, infrastructure/Kubernetes tools, service listing tools, or catalog tools.
2. Run MULTIPLE discovery queries to build a comprehensive catalog. Do NOT stop at the first query — use several approaches and merge the results:

   **If infrastructure tools are available (e.g., Kubernetes API):**
   - Use metric queries FIRST for the initial sweep (deployments, statefulsets, daemonsets)
   - THEN use a filtered pod list as a SECOND PASS to catch container-level services
     that don't have their own deployment (e.g., sidecar containers, celery workers,
     multi-container pods). Many services are containers within a deployment whose
     name differs from the deployment name — metrics alone miss these.
   - When listing pods, ALWAYS use fieldSelector or labelSelector to exclude system
     namespaces (kube-system, kube-public, kube-node-lease). Do NOT fetch all pods
     unfiltered — that returns 80k+ chars and wastes your token budget.

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

Return a JSON OBJECT with two top-level fields:
- "services": array of service objects (see shape below)
- "globalProbeRules": array of stack-aware probe rule objects written AFTER you
  introspect the Prometheus label key this stack actually uses (see section
  "Global Probe Rules" below). Empty array is acceptable if the introspection
  does not succeed.

BACKWARD COMPAT: Clients still accept a bare JSON array of services (treated
as { services: [...], globalProbeRules: [] }). Prefer the object form when
you can produce globalProbeRules.

## Per-Service Shape

Each service in "services" must have:
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

- "probeRules" (REQUIRED when minimum context exists — you almost always have it):
  array of per-service anomaly detection rules for the proactive scan probe.
  These are the rules that CANNOT be written as globalProbeRules because they
  need the SERVICE'S specific labels (its namespace, its log container, or the
  specific health-check query you wrote for this service). A services.yaml
  with empty probeRules on every service means the probe cannot detect
  outages, pod-restart storms, or log-error bursts. Discovery writing these
  rules is the whole point of slicing per-service context out of your tool
  calls.

  EMIT ALL THREE OF THESE RULES FOR EACH SERVICE unless the explicit omission
  clause below applies. Do not ship \`probeRules: []\` as a default — that is
  an escape hatch for the rare service with zero context, NOT a safe default.

  (1) service_availability (source: "metrics") — EMIT whenever the service has
      a non-empty \`metrics\` array. This is the most important rule for
      coverage: globalProbeRules assume a single majority-wins label key that
      matches the service name (e.g. \`up{app="{service}"}\`). Many stacks mix
      discovery sources — some services register via kube-state-metrics, some
      via Consul, some via a service mesh — and for any service whose backing
      workload name differs from its registered service name (headless
      Services, webhook Services, service-mesh proxies, operator-managed
      workloads) the globalProbeRule silently misses. The per-service
      availability rule fixes that because YOU already wrote a health-check
      query that IS known to return data for this specific service —
      \`metrics[0].query\`. Promote it to a rule.

        {
          "name": "service_availability",
          "query": "<the exact metrics[0].query string you wrote for this service>",
          "threshold": { "op": "lt", "value": 1 },
          "consecutiveTicks": 3,
          "source": "metrics"
        }

      The health-check query MUST be a true ready/available indicator that
      actually drops to 0 when the service is failing. \`lt 1\` only trips
      when the value reaches 0, so a "desired-replica-count" metric is NOT
      a valid health check — those stay >0 even when every pod is in
      CrashLoopBackOff, ImagePullBackOff, or Pending. Pick a metric that
      reflects real readiness:

        Workload kind            USE                                          DO NOT USE
        ─────────────────────    ───────────────────────────────────────────  ──────────────────────────────────
        Deployment               kube_deployment_status_replicas_available    kube_deployment_status_replicas
                                 kube_deployment_status_replicas_ready        kube_deployment_spec_replicas
        StatefulSet              kube_statefulset_status_replicas_ready       kube_statefulset_status_replicas
                                                                              kube_statefulset_replicas
        DaemonSet                kube_daemonset_status_number_ready           kube_daemonset_status_desired_number_scheduled
                                                                              kube_daemonset_status_current_number_scheduled
        Service-level / app      up{...}=1                                    n/a (\`up\` is the canonical readiness gauge)
        Consul                   consul_catalog_service_node_healthy          n/a

      Why: \`kube_*_status_replicas\` reports \`.status.replicas\` (total
      non-terminated pods, including unhealthy ones). It only drops below 1
      when you scale to 0 or delete the workload — so it silently misses
      every real outage. Same trap for \`kube_daemonset_status_desired_number_scheduled\`
      (count of nodes that *should* run a pod, not how many actually are).
      Always reach for the \`_available\` / \`_ready\` / \`number_ready\`
      variant.

      The \`service_availability\` rule reuses \`metrics[0].query\` verbatim.
      That means \`metrics[0].query\` itself MUST be a real readiness gauge —
      do not write a desired-count query into \`metrics[0]\` either. If you
      need to query both ready and desired counts as separate metrics, make
      sure the FIRST metric in the array is the readiness one.

      consecutiveTicks: 3 matches the globalProbeRule hysteresis so the
      signal isn't noisier than the global-track equivalent.

      Only omit this rule if \`metrics\` is empty — i.e. you couldn't find
      ANY query that identifies this service. That is rare and indicates the
      service probably shouldn't have made it into the registry.

  (2) pod_restarts (source: "metrics") — EMIT whenever you know the service's
      namespace OR a workload selector (deployment/statefulset/daemonset name).
      You almost always know at least one of these from your discovery queries
      — \`kube_pod_info\`, \`kube_deployment_status_replicas_available\`, pod
      lists, etc. all carry a namespace label.

      Service-specific selector required when feasible. A namespace-only
      selector counts restarts from EVERY pod in the namespace and attributes
      them to this one service — when multiple services share a namespace
      (e.g. several DBs in \`namespace="db"\`), one bad pod fires
      \`pod_restarts\` for every service in the namespace, and they all blame
      each other. Always narrow further when you have the data.

      Selector priority (use the FIRST that applies):

        1. \`{deployment="<name>"}\`, \`{statefulset="<name>"}\`,
           \`{daemonset="<name>"}\` — kube-state-metrics emits
           \`kube_pod_container_status_restarts_total\` joined with these
           workload labels via recording rules on most stacks. If the
           label is present in your stack's metrics, prefer it.
        2. \`{namespace="<ns>",pod=~"<workload>-.*"}\` — when the
           workload name prefixes its pods (Deployment ReplicaSet hash
           or StatefulSet ordinal), a regex match on \`pod=~\` narrows
           to this service's pods inside the namespace. Always include
           the trailing \`.*\` and anchor the prefix.
        3. \`{namespace="<ns>"}\` — last-resort fallback when no workload
           selector is known AND no pod-name prefix is identifiable. Use
           this only when the namespace contains exactly one service.

      Examples:

        Best:    rate(kube_pod_container_status_restarts_total{deployment="checkout-api"}[5m])
        Good:    rate(kube_pod_container_status_restarts_total{namespace="checkout",pod=~"checkout-api-.*"}[5m])
        Risky:   rate(kube_pod_container_status_restarts_total{namespace="checkout"}[5m])

      Rule shape:

        {
          "name": "pod_restarts",
          "query": "<one of the forms above>",
          "threshold": { "op": "gt", "value": 0.033 },
          "consecutiveTicks": 2,
          "source": "metrics"
        }

      0.033 per second ≈ 2 restarts per minute — the first-level trip
      threshold.

      Only omit this rule if you truly could not identify a namespace NOR a
      workload selector for this service. That is rare — state it explicitly
      in a \`"description"\` field on the service if you hit this case, so an
      operator can see why the rule is missing.

  (3) log_errors (source: "logs") — EMIT whenever \`logLabels\` is non-empty.
      You already wrote logLabels one field above; reuse them verbatim.

        {
          "name": "log_errors",
          "query": "sum(count_over_time({<logLabels as key=\\"value\\" selectors>} |= \`error\` or \`fatal\` [15m]))",
          "threshold": { "op": "gt", "value": 75 },
          "consecutiveTicks": 2,
          "source": "logs"
        }

      Example — for logLabels={namespace:"checkout",container:"api"}:
        "query": "sum(count_over_time({namespace=\\"checkout\\",container=\\"api\\"} |= \`error\` or \`fatal\` [15m]))"

      Threshold 75 is a raw count over the 15m window (~5 errors/min × 15 min).
      The probe does NOT divide by window duration — the scalar returned by the
      logs tool is the raw count. A wrong Loki provider is fine — the probe
      scores NaN and moves on, no false-positive risk.

      Only omit this rule if \`logLabels\` is genuinely empty (no log labels
      could be discovered). If you wrote logLabels, write log_errors.

  When to write \`probeRules: []\`:
    ONLY when \`metrics\` is empty AND \`logLabels\` is empty AND you truly
    could not identify a namespace or workload selector. That combination
    means you have zero per-service context — unusual for a service that
    made it into the registry at all. Every service with a non-empty
    \`metrics\` array gets at least service_availability. Every service with
    non-empty \`logLabels\` gets at least log_errors. Most get all three.

- "gitlabProject" (optional): GitLab project path if you know it.
- "corootAppId" (optional): Coroot application ID if you know it.

## Global Probe Rules

"globalProbeRules" is a top-level array of stack-aware probe rules. The probe
applies each global rule to every registered service (by substituting
"{service}" in the query for the service name). The purpose: write ONE set of
rules with the RIGHT label key for this stack, so operators don't have to
hand-edit config.yaml when their cluster uses \`app=\` instead of \`deployment=\`
or \`service=\`.

Process:
  1. Inspect the Prometheus metrics you queried during service discovery.
     Look at which labels appear most often across workload metrics — common
     candidates are \`app\`, \`service\`, \`job\`, \`deployment\`, \`statefulset\`,
     \`daemonset\`, \`workload\`, \`component\`.
  2. Pick the MAJORITY-WINS key — the one that appears on the most service-
     identifying metrics. For example, if most services surface via
     \`up{app="..."}\` but a few via \`up{job="..."}\`, the majority key is \`app\`.
  3. Write availability and (optionally) error-rate rules using that key.
     These OVERRIDE the hardcoded config.yaml defaults for every service.

Example — a stack where \`app\` is the majority label key:
  "globalProbeRules": [
    {
      "name": "app_availability",
      "query": "up{app=\\"{service}\\"}",
      "threshold": { "op": "lt", "value": 1 },
      "consecutiveTicks": 3,
      "source": "metrics"
    }
  ]

Example — a stack where \`deployment\` / \`statefulset\` / \`daemonset\`
kube-state-metrics labels are standard (no rewrite needed):
  "globalProbeRules": []      // fall through to the hardcoded k8s defaults

Leave globalProbeRules: [] (or omit) if the stack's label convention matches
the hardcoded config.yaml defaults (deployment / statefulset / daemonset
kube-state-metrics labels) — the defaults already cover it, don't duplicate.

Be thorough — discover ALL services. Return valid JSON.

OUTPUT STRICTNESS: Return PURE JSON only. Do NOT include JavaScript-style
comments (// or /* */), trailing commas, or section headers inside any array.
If you want to group services conceptually, use an extra field like
"category": "deployment" | "statefulset" | "daemonset" | "container" on
the service object itself — do not use inline comments as dividers.${excludeList}`;
}

export function createDiscoverAgent(config: DiscoverAgentConfig) {
  const instructions = buildDiscoverInstructions(config);
  return new Agent({
    id: "discover",
    name: "discover",
    instructions: () => instructions,
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

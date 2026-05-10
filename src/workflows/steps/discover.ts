import { createDiscoverAgent } from "../../agents/discover.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { getToolsByRole } from "../../mcp/provider.js";
import { wrapToolsWithCallbacks } from "../tool-utils.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig, DiscoveryConfig, DiscoveryRecipe, ProbeMetricRule } from "../../config/schema.js";
import { ProbeMetricRuleSchema } from "../../config/schema.js";
import type { OnToolCallEnriched, OnIteration } from "../../types/agent-interfaces.js";
import type { Skill } from "../../skills/store.js";
import type { LlmRetryConfig } from "../../agents/shared/llm-retry.js";
import { withLlmRetry, safeAgentRetryConfig } from "../../agents/shared/llm-retry.js";
import { LlmUnavailableError } from "../../agents/shared/llm-errors.js";
import { UNTRUSTED_DATA_NOTICE, wrapUntrusted } from "../../agents/shared/prompt-helpers.js";
import { logLlmCall, logLlmCallStart, logToolCall, newCallId, type ToolCallEvent } from "../../server/llm-logger.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("discover");

export interface DiscoverStepConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  onRetry?: (attempt: number, maxRetries: number, reason: string) => void;
  skills?: Skill[];
  maxCharsPerSkill?: number;
  /** Retry config for transient LLM-call failures. Falls back to no-retry when omitted. */
  llmRetry?: LlmRetryConfig;
  /** Caller cancellation signal (e.g. WebSocket disconnect, supersede-on-new-discover). */
  abortSignal?: AbortSignal;
  /**
   * Per-attempt timeout for the discover agent's `generate()` call. Without
   * this, a silently-stalled LLM stream (mid-stream socket reset with no
   * error surface) hangs forever — the AI SDK has no built-in idle timeout
   * and `withLlmRetry` only catches thrown errors. With it, each attempt
   * aborts after `llmCallMs` and surfaces a TimeoutError the retry layer
   * classifies as transient.
   */
  llmCallMs?: number;
}

const MAX_RETRIES = 3;

/**
 * Per-tool-result budget retained for the stall-recovery follow-up prompt.
 * Larger than the 500-char observability slice (which only feeds logs and the
 * UI tool-call panel) because the recovery prompt needs enough context for
 * the model to actually synthesize JSON from the prior tool data.
 */
const RECOVERY_TOOL_RESULT_CHARS = 4000;

/**
 * Per-attempt timeout for the stall-recovery `agent.generate` call. Recovery
 * runs with toolChoice: "none", so it can't go on a tool-calling jaunt — a
 * single forward pass is enough. 60s leaves room for slow first-token times
 * on busy gateways without inheriting the 120s exploration budget.
 */
const RECOVERY_TIMEOUT_MS = 60_000;

function createLlmTimeoutError(timeoutMs: number): Error {
  const err = new Error(`LLM call timed out after ${timeoutMs}ms`);
  err.name = "TimeoutError";
  return err;
}

function isLlmTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

function createDiscoveryAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "Discovery aborted");
  err.name = "AbortError";
  return err;
}

function throwIfDiscoveryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createDiscoveryAbortError(signal.reason);
}

/**
 * `AbortSignal` is cooperative: it only helps if every layer in Mastra, the AI
 * SDK, undici, and the upstream gateway settles the promise on abort. Keep a
 * hard wall-clock timeout around the call so discovery can always leave the
 * "LLM is analyzing" state even when one layer ignores cancellation.
 *
 * `parentSignal` chains a caller-owned signal (e.g. WebSocket disconnect)
 * into the same race so callers can cancel even when the underlying agent
 * never settles. Without it, `runDiscoverStep` would only honor the local
 * timeout and ignore upstream cancellation.
 */
async function runWithHardTimeout<T>(
  timeoutMs: number | undefined,
  run: (abortSignal?: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  throwIfDiscoveryAborted(parentSignal);

  const hasTimeout = timeoutMs !== undefined && timeoutMs > 0;
  if (!hasTimeout && !parentSignal) return run(undefined);

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeParentAbortListener: (() => void) | undefined;
  const timeoutPromise = hasTimeout ? new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const err = createLlmTimeoutError(timeoutMs!);
      controller.abort(err);
      reject(err);
    }, timeoutMs!);
  }) : undefined;
  const parentAbortPromise = parentSignal ? new Promise<never>((_, reject) => {
    const onAbort = () => {
      const err = createDiscoveryAbortError(parentSignal.reason);
      controller.abort(err);
      reject(err);
    };
    parentSignal.addEventListener("abort", onAbort, { once: true });
    removeParentAbortListener = () => parentSignal.removeEventListener("abort", onAbort);
  }) : undefined;

  try {
    const contenders: Array<Promise<T> | Promise<never>> = [
      Promise.resolve().then(() => run(controller.signal)),
    ];
    if (timeoutPromise) contenders.push(timeoutPromise);
    if (parentAbortPromise) contenders.push(parentAbortPromise);
    return await Promise.race(contenders);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeParentAbortListener?.();
  }
}

function discoverRetryConfig(config: DiscoverStepConfig): LlmRetryConfig {
  const base = safeAgentRetryConfig(config.llmRetry, true);
  return config.onRetry ? { ...base, onRetry: config.onRetry } : base;
}

const STALL_RECOVERY_PROMPT_HEADER =
  "You previously made the following tool calls during service discovery. " +
  "Based ONLY on this data, output the services list as JSON now. " +
  "Do NOT call more tools. " +
  "Use the exact JSON shape from your original instructions: " +
  '{"services": [...], "globalProbeRules": [...]}. ' +
  "Each service object must include name, metrics, logLabels, and probeRules. " +
  `${UNTRUSTED_DATA_NOTICE} ` +
  "Output JSON only — no prose, no markdown fences.";

const DEFAULT_PROMETHEUS_RECIPE: DiscoveryRecipe = {
  providerType: "prometheus-k8s",
  serviceQueries: [
    'count by (deployment) (kube_deployment_status_replicas)',
    'count by (statefulset) (kube_statefulset_status_replicas)',
    'count by (daemonset) (kube_daemonset_status_desired_number_scheduled)',
    'count by (container) (kube_pod_container_info{container!="POD",container!=""})',
    'count by (app) (kube_pod_info)',
    'count by (job) (up)',
  ],
  labelKeys: ["app", "container_name", "job", "component", "name", "service", "chart", "release"],
};

interface DatasourceHintResult {
  hintBlock: string;
  uidMap: Map<string, string>;
}

/**
 * Call `list_datasources` on a discovery tool map and format the result as a
 * `<untrusted_datasource_hints>` block the agent can consume. Also returns a
 * short-name → real-UID map for tool-arg coercion. Returns empty hint block
 * and empty map if no tool is available or the call fails.
 */
async function fetchDatasourceHintsForDiscover(
  tools: Record<string, any>,
): Promise<DatasourceHintResult> {
  const empty: DatasourceHintResult = { hintBlock: "", uidMap: new Map() };
  const entry = Object.entries(tools).find(([name]) => name.includes("list_datasources"));
  if (!entry) return empty;
  const [toolName, tool] = entry;

  try {
    const raw = await tool.execute?.({ limit: 100, offset: 0 });
    if (!raw) return empty;

    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw?.content?.[0]?.text) {
      text = raw.content[0].text;
    } else {
      text = JSON.stringify(raw);
    }

    const parsed = JSON.parse(text);
    const datasources = (Array.isArray(parsed) ? parsed : parsed?.datasources ?? []) as Array<{
      uid: string;
      name: string;
      type: string;
    }>;
    const relevant = datasources.filter((d) => d.type === "prometheus" || d.type === "loki");
    if (relevant.length === 0) return empty;

    const uidMap = new Map<string, string>();
    for (const d of relevant) {
      if (!uidMap.has(d.type)) uidMap.set(d.type, d.uid);
    }

    const lines = relevant.map((d) => `- ${d.type}: datasourceUid="${d.uid}" (${d.name})`);
    const hintBlock =
      `<untrusted_datasource_hints>Available datasources (use these UIDs directly, do NOT guess or call list_datasources):\n${lines.join("\n")}\n` +
      `IMPORTANT: You MUST use the exact datasourceUid values above when calling query_prometheus, query_loki_logs, or list_loki_label_names. Do not invent short names like "loki" or "prometheus-k8s" — always use the real UIDs.</untrusted_datasource_hints>\n\n`;

    return { hintBlock, uidMap };
  } catch {
    void toolName;
    return empty;
  }
}

/**
 * Format discovery recipes into a prompt-friendly string.
 */
function formatRecipeHints(recipes: DiscoveryRecipe[]): string {
  return recipes.map((recipe) => {
    const lines: string[] = [`### ${recipe.providerType}`];
    if (recipe.serviceQueries.length > 0) {
      lines.push("Suggested queries:");
      for (const q of recipe.serviceQueries) {
        lines.push(`- ${q}`);
      }
    }
    if (recipe.labelKeys.length > 0) {
      lines.push(`Service label keys: ${recipe.labelKeys.join(", ")}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

/**
 * Output of `runDiscoverStep`. `services` is the per-service list the LLM
 * wrote; `globalProbeRules` is the top-level stack-aware rule array the
 * agent produced after introspecting the Prometheus label key (empty when
 * the stack matches the hardcoded k8s defaults or the agent couldn't
 * introspect — both are valid no-op outcomes, the probe falls through to
 * the config.yaml defaults).
 */
export interface DiscoverStepResult {
  services: ServiceConfig[];
  globalProbeRules: ProbeMetricRule[];
}

/**
 * Rule-name regex — matches scan-rule-validator (GUI path). Names cannot
 * contain `:` because the scheduler's consecutiveState Map keys by
 * `{service}:{origin}:{ruleName}` and splits on colons. A rule name with
 * an embedded colon would silently corrupt state-key parsing.
 */
const SAFE_RULE_NAME_RE = /^[^:]+$/;

/**
 * Zod-validate LLM-written probe rules before they touch the registry or
 * the scan probe. Drops (and logs) any rule that fails shape validation
 * or contains an unsafe name. Addresses the LLM-trust-boundary gap
 * surfaced in the 2026-04-22 adversarial review.
 */
function validateDiscoveredRules(raw: unknown[], source: string): ProbeMetricRule[] {
  const out: ProbeMetricRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const parsed = ProbeMetricRuleSchema.safeParse(entry);
    if (!parsed.success) {
      logger.warn({
        source,
        index: i,
        rawEntry: entry,
        errors: parsed.error.issues.slice(0, 3).map((x) => ({ path: x.path.join("."), message: x.message })),
      }, `discovery: dropping invalid ${source} rule at index ${i} — fails ProbeMetricRuleSchema`);
      continue;
    }
    if (!SAFE_RULE_NAME_RE.test(parsed.data.name)) {
      logger.warn({
        source,
        index: i,
        ruleName: parsed.data.name,
      }, `discovery: dropping ${source} rule with unsafe name (colon reserved for state-key encoding)`);
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

/**
 * Best-effort shape check for an LLM-written services array. The full
 * `ServiceSchema` is Zod-validated downstream via runValidateStep, which
 * drops services that fail shape. Here we only scrub the `probeRules`
 * field before validation sees it — the same LLM-trust-boundary concern
 * as globalProbeRules. Services whose own fields are malformed continue
 * to reach validation for richer diagnostics there.
 */
function validateDiscoveredServices(raw: unknown[]): ServiceConfig[] {
  const out: ServiceConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const svc = entry as Record<string, unknown>;
    if (typeof svc.name !== "string") {
      logger.warn({ rawEntry: entry }, "discovery: dropping service with missing/non-string name");
      continue;
    }
    const rawProbeRules = Array.isArray(svc.probeRules) ? svc.probeRules : [];
    const probeRules = validateDiscoveredRules(rawProbeRules, `service.${svc.name}.probeRules`);
    backfillServiceAvailability(svc.name, svc.metrics, probeRules);
    out.push({ ...(svc as ServiceConfig), probeRules });
  }
  return out;
}

/**
 * Deterministic backfill of the `service_availability` probe rule.
 *
 * The prompt asks the LLM to promote the service's `metrics[0].query` into
 * a `service_availability` rule (the query is, by definition, known to
 * identify this specific service). In practice LLM compliance on this is
 * unreliable — a real run on gpt-oss-120b against an 82-service stack
 * produced 0 of 61 services with the rule, and the remaining blind spots
 * were exactly the services whose global availability rule silently missed.
 *
 * The rule is mechanically derivable — query = metrics[0].query, threshold
 * = lt 1, consecutiveTicks = 3 (matches globalProbeRule hysteresis). There
 * is no discovery-time judgment the LLM needs to contribute beyond picking
 * metrics[0], which it already did. So we do it here, deterministically.
 *
 * Pre-prepended (not appended) so operators reading services.yaml see the
 * cross-workload availability signal first, before the namespace-scoped
 * pod_restarts / log-source rules.
 */
function backfillServiceAvailability(
  serviceName: string,
  rawMetrics: unknown,
  probeRules: ProbeMetricRule[],
): void {
  if (probeRules.some((r) => r.name === "service_availability")) return;
  if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) return;
  const first = rawMetrics[0] as Record<string, unknown> | undefined;
  const query = first && typeof first.query === "string" ? first.query.trim() : "";
  if (!query) return;
  probeRules.unshift({
    name: "service_availability",
    query,
    threshold: { op: "lt", value: 1 },
    consecutiveTicks: 3,
    source: "metrics",
  });
  logger.debug({ service: serviceName, query }, "discovery: backfilled service_availability rule from metrics[0]");
}

const PROM_LABEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function decodePromLabelValue(rawValue: string): string {
  try {
    return JSON.parse(`"${rawValue}"`) as string;
  } catch {
    return rawValue.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
}

function extractUpLabelValues(query: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const selectorRe = /\bup\s*\{([^}]*)\}/g;
  let selectorMatch: RegExpExecArray | null;
  while ((selectorMatch = selectorRe.exec(query)) !== null) {
    const selector = selectorMatch[1] ?? "";
    const labelRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"/g;
    let labelMatch: RegExpExecArray | null;
    while ((labelMatch = labelRe.exec(selector)) !== null) {
      out.push({
        label: labelMatch[1]!,
        value: decodePromLabelValue(labelMatch[2] ?? ""),
      });
    }
  }
  return out;
}

export function backfillGlobalAvailabilityRules(
  services: ServiceConfig[],
  globalProbeRules: ProbeMetricRule[],
): void {
  if (services.length < 2) return;
  if (globalProbeRules.some((rule) => rule.query.includes("{service}"))) return;

  const counts = new Map<string, number>();
  for (const service of services) {
    const seenForService = new Set<string>();
    for (const metric of service.metrics ?? []) {
      for (const { label, value } of extractUpLabelValues(metric.query)) {
        if (value === service.name) seenForService.add(label);
      }
    }
    for (const label of seenForService) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  const minimumMatches = Math.max(2, Math.ceil(services.length * 0.5));
  const best = [...counts.entries()]
    .filter(([label, count]) => PROM_LABEL_NAME_RE.test(label) && count >= minimumMatches)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!best) return;

  const [label, matchedServices] = best;
  const name = `${label}_availability`;
  if (globalProbeRules.some((rule) => rule.name === name)) return;

  const query = `up{${label}="{service}"}`;
  globalProbeRules.unshift({
    name,
    query,
    threshold: { op: "lt", value: 1 },
    consecutiveTicks: 3,
    source: "metrics",
  });
  logger.debug({ rule: name, query, matchedServices, serviceCount: services.length }, "discovery: backfilled global availability rule");
}

/**
 * Try every parse path the discover agent's response could take and return
 * a non-empty DiscoverStepResult, or null if nothing usable was found.
 * Shared between the primary attempt and the stall-recovery follow-up so
 * both go through identical validation.
 */
function tryParseDiscoverResponse(text: string | undefined): DiscoverStepResult | null {
  if (!text) return null;
  const parsed = safeJsonParse(text);
  if (Array.isArray(parsed) && parsed.length > 0) {
    const services = validateDiscoveredServices(parsed);
    const globalProbeRules: ProbeMetricRule[] = [];
    backfillGlobalAvailabilityRules(services, globalProbeRules);
    return { services, globalProbeRules };
  }
  if (parsed && typeof parsed === "object") {
    const rawServices = Array.isArray(parsed.services) ? parsed.services : [];
    const rawGlobals = Array.isArray(parsed.globalProbeRules) ? parsed.globalProbeRules : [];
    const globalProbeRules = validateDiscoveredRules(rawGlobals, "globalProbeRules");
    const services = validateDiscoveredServices(rawServices);
    backfillGlobalAvailabilityRules(services, globalProbeRules);
    if (services.length > 0 || globalProbeRules.length > 0) {
      return { services, globalProbeRules };
    }
  }
  return null;
}

interface RecoveryToolEntry {
  tool: string;
  args: string;
  result: string;
}

interface DiscoveryCandidate {
  name: string;
  source: "deployment" | "statefulset" | "daemonset" | "consul";
  namespace?: string;
  metricQuery: string;
  metricDescription: string;
  logLabels: Record<string, string>;
  restartQuery?: string;
}

const CANDIDATE_SOURCE_PRIORITY: Record<DiscoveryCandidate["source"], number> = {
  deployment: 4,
  statefulset: 3,
  daemonset: 3,
  consul: 2,
};

function promLabelEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function selector(labels: Record<string, string | undefined>): string {
  const parts = Object.entries(labels)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}="${promLabelEscape(value)}"`);
  return `{${parts.join(",")}}`;
}

function logSelector(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${promLabelEscape(value)}"`)
    .join(",");
}

function normalizeServiceName(name: string): string {
  return name.trim().toLowerCase();
}

function isExcludedService(name: string, excludeServices: string[] | undefined): boolean {
  const normalized = normalizeServiceName(name);
  return (excludeServices ?? []).some((excluded) => normalizeServiceName(excluded) === normalized);
}

function candidateKey(name: string): string {
  return normalizeServiceName(name);
}

function candidateProbeRules(candidate: DiscoveryCandidate): ProbeMetricRule[] {
  const rules: ProbeMetricRule[] = [{
    name: "service_availability",
    query: candidate.metricQuery,
    threshold: { op: "lt", value: 1 },
    consecutiveTicks: 3,
    source: "metrics",
  }];

  if (candidate.restartQuery) {
    rules.push({
      name: "pod_restarts",
      query: candidate.restartQuery,
      threshold: { op: "gt", value: 0.033 },
      consecutiveTicks: 2,
      source: "metrics",
    });
  }

  if (Object.keys(candidate.logLabels).length > 0) {
    rules.push({
      name: "log_errors",
      query: `sum(count_over_time({${logSelector(candidate.logLabels)}} |= \`error\` or \`fatal\` [15m]))`,
      threshold: { op: "gt", value: 75 },
      consecutiveTicks: 2,
      source: "logs",
    });
  }

  return rules;
}

function serviceQueries(service: ServiceConfig): string {
  return (service.metrics ?? []).map((metric) => metric.query).join("\n").toLowerCase();
}

function isDaemonSetBackedService(service: ServiceConfig): boolean {
  const queries = serviceQueries(service);
  return queries.includes("kube_daemonset_") || queries.includes("daemonset=");
}

function isStatefulSetBackedService(service: ServiceConfig): boolean {
  const queries = serviceQueries(service);
  return queries.includes("kube_statefulset_") || queries.includes("statefulset=");
}

function isLowSignalInfrastructureService(service: ServiceConfig): boolean {
  const name = normalizeServiceName(service.name);
  if (isStatefulSetBackedService(service) && /-shard\d+$/.test(name)) return true;
  if (!isDaemonSetBackedService(service)) return false;
  return (
    /^kube-(proxy|flannel(?:-ds-.+)?)$/.test(name) ||
    /^openebs-/.test(name) ||
    name === "promtail" ||
    name === "prometheus-node-exporter" ||
    name === "process-exporter" ||
    name === "speaker" ||
    name.endsWith("-node-agent")
  );
}

function serviceFromCandidate(candidate: DiscoveryCandidate): ServiceConfig {
  return {
    name: candidate.name,
    metrics: [{ query: candidate.metricQuery, description: candidate.metricDescription }],
    logLabels: candidate.logLabels,
    probeRules: candidateProbeRules(candidate),
  };
}

function addCandidate(
  candidates: Map<string, DiscoveryCandidate>,
  candidate: DiscoveryCandidate,
  excludeServices: string[] | undefined,
): void {
  if (!candidate.name || isExcludedService(candidate.name, excludeServices)) return;
  const key = candidateKey(candidate.name);
  const existing = candidates.get(key);
  if (!existing || CANDIDATE_SOURCE_PRIORITY[candidate.source] > CANDIDATE_SOURCE_PRIORITY[existing.source]) {
    candidates.set(key, candidate);
  }
}

function parsePrometheusMetricRows(resultText: string): Array<Record<string, string>> {
  try {
    const parsed = JSON.parse(resultText) as unknown;
    const rows =
      Array.isArray((parsed as { data?: unknown })?.data)
        ? (parsed as { data: unknown[] }).data
        : Array.isArray((parsed as { data?: { result?: unknown[] } })?.data?.result)
          ? (parsed as { data: { result: unknown[] } }).data.result
          : Array.isArray((parsed as { result?: unknown[] })?.result)
            ? (parsed as { result: unknown[] }).result
            : [];
    return rows
      .map((row) => (row && typeof row === "object" ? (row as { metric?: unknown }).metric : undefined))
      .filter((metric): metric is Record<string, string> => {
        if (!metric || typeof metric !== "object") return false;
        return Object.values(metric).every((value) => typeof value === "string");
      });
  } catch {
    return [];
  }
}

function extractDiscoveryCandidates(
  args: Record<string, unknown>,
  resultText: string,
  excludeServices: string[] | undefined,
): DiscoveryCandidate[] {
  const expr = String(args["expr"] ?? args["query"] ?? "");
  if (!expr) return [];
  const metrics = parsePrometheusMetricRows(resultText);
  const out: DiscoveryCandidate[] = [];

  for (const metric of metrics) {
    const namespace = metric["namespace"];
    if (metric["deployment"]) {
      const name = metric["deployment"];
      out.push({
        name,
        source: "deployment",
        namespace,
        metricQuery: `kube_deployment_status_replicas_available${selector({ deployment: name, namespace })}`,
        metricDescription: "Deployment available replicas",
        logLabels: namespace ? { namespace, container_name: name } : { container_name: name },
        restartQuery: `rate(kube_pod_container_status_restarts_total${selector({ deployment: name })}[5m])`,
      });
    } else if (metric["statefulset"]) {
      const name = metric["statefulset"];
      // No restartQuery: kube_pod_container_status_restarts_total has no
      // statefulset label by default (kube-state-metrics labels are
      // namespace/pod/container/uid/node), so the rule would always read 0.
      // Leave it to LLM-driven discovery to emit a per-cluster correct query.
      out.push({
        name,
        source: "statefulset",
        namespace,
        metricQuery: `kube_statefulset_status_replicas_ready${selector({ statefulset: name, namespace })}`,
        metricDescription: "StatefulSet ready replicas",
        logLabels: namespace ? { namespace, container_name: name } : { container_name: name },
      });
    } else if (metric["daemonset"]) {
      const name = metric["daemonset"];
      // No restartQuery: see statefulset note above. Same label-shape problem.
      out.push({
        name,
        source: "daemonset",
        namespace,
        metricQuery: `kube_daemonset_status_number_ready${selector({ daemonset: name, namespace })}`,
        metricDescription: "DaemonSet ready pods",
        logLabels: namespace ? { namespace, container_name: name } : { container_name: name },
      });
    } else if (expr.includes("consul_catalog_service_node_healthy") && metric["service_name"]) {
      const type = metric["type"] ?? metric["service_type"] ?? metric["service_kind"] ?? metric["kubernetes_service_type"];
      if (type && type !== "ExternalName") continue;
      const name = metric["service_name"];
      out.push({
        name,
        source: "consul",
        metricQuery: `consul_catalog_service_node_healthy${selector({ service_name: name })}`,
        metricDescription: "Consul health status",
        logLabels: {},
      });
    }
  }

  return out.filter((candidate) => !isExcludedService(candidate.name, excludeServices));
}

function mergeCandidatesIntoDiscoveryResult(
  result: DiscoverStepResult,
  candidates: Map<string, DiscoveryCandidate>,
  excludeServices: string[] | undefined,
): DiscoverStepResult {
  const droppedFromLlm = result.services.filter((service) => isLowSignalInfrastructureService(service));
  const services = result.services.filter((service) =>
    !isExcludedService(service.name, excludeServices) &&
    !isLowSignalInfrastructureService(service)
  );
  const existing = new Set(services.map((service) => candidateKey(service.name)));
  const added: ServiceConfig[] = [];
  const sourceCounts = [...candidates.values()].reduce((counts, candidate) => {
    counts.set(candidate.source, (counts.get(candidate.source) ?? 0) + 1);
    return counts;
  }, new Map<DiscoveryCandidate["source"], number>());

  for (const candidate of [...candidates.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = candidateKey(candidate.name);
    if (existing.has(key)) continue;
    const sourceCount = sourceCounts.get(candidate.source) ?? 0;
    if ((candidate.source === "statefulset" || candidate.source === "daemonset") && sourceCount > 10) {
      continue;
    }
    const service = serviceFromCandidate(candidate);
    if (isLowSignalInfrastructureService(service)) continue;
    existing.add(key);
    added.push(service);
  }

  if (droppedFromLlm.length > 0) {
    logger.warn(
      {
        droppedServiceCount: droppedFromLlm.length,
        examples: droppedFromLlm.slice(0, 10).map((service) => service.name),
      },
      "discovery: dropped low-signal infrastructure services from LLM output",
    );
  }

  if (added.length > 0) {
    logger.warn(
      {
        llmServiceCount: result.services.length,
        addedServiceCount: added.length,
        candidateServiceCount: candidates.size,
      },
      "discovery: added services deterministically from observed metric/catalog rows",
    );
  }

  return {
    services: [...services, ...added],
    globalProbeRules: result.globalProbeRules,
  };
}

export const discoverStepTestHooks = {
  extractDiscoveryCandidates,
  mergeCandidatesIntoDiscoveryResult,
};

/**
 * Format the captured tool history for inline inclusion in the stall-recovery
 * prompt. Each entry is a self-contained block so the model can scan top-down.
 */
function formatRecoveryToolHistory(history: RecoveryToolEntry[]): string {
  return history
    .map((entry, idx) => {
      const header = `### Tool call ${idx + 1}: ${entry.tool}`;
      return [
        header,
        "Args:",
        wrapUntrusted("tool_args", entry.args),
        "Result:",
        wrapUntrusted("tool_result", entry.result),
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

export async function runDiscoverStep(config: DiscoverStepConfig): Promise<DiscoverStepResult> {
  throwIfDiscoveryAborted(config.abortSignal);
  let discoveryTools: Record<string, any>;
  try {
    const [metrics, infra] = await Promise.all([
      getToolsByRole(config.providers, "metrics").catch(() => ({})),
      getToolsByRole(config.providers, "infrastructure").catch(() => ({})),
    ]);
    discoveryTools = { ...metrics, ...infra };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP connection failed — cannot reach monitoring providers. ${msg}`);
  }
  if (Object.keys(discoveryTools).length === 0) {
    throw new Error("No MCP tools available — check that your monitoring MCP server is running and has the 'metrics' or 'infrastructure' role.");
  }

  // Build recipe hints for the discover agent prompt
  const configuredRecipes = config.discoveryConfig.discoveryRecipes ?? [];
  const effectiveRecipes = configuredRecipes.length > 0
    ? configuredRecipes
    : [DEFAULT_PROMETHEUS_RECIPE];
  const recipeHints = formatRecipeHints(effectiveRecipes);

  // Keep maxSteps capped so the quirk wind-down (which disables tools to
  // force JSON output) fires before the model exhausts all iterations.
  // The agent runs multiple discovery queries (deployments, statefulsets,
  // daemonsets, pods, scrape targets) so it needs enough iterations.
  const maxSteps = Math.min(config.discoveryConfig.maxIterations, 35);

  // Wrap tools with callbacks and emit synthetic iteration events based on tool call count
  let toolCallCount = 0;
  const discoveredCandidates = new Map<string, DiscoveryCandidate>();
  const wrappedOnToolCall: typeof config.onToolCall = config.onToolCall
    ? (name, args, result, durationMs, error, phase) => {
        toolCallCount++;
        config.onIteration?.("discovery", toolCallCount, maxSteps, `Querying ${name}`);
        config.onToolCall!(name, args, result, durationMs, error, phase);
      }
    : undefined;
  const recordRawDiscoveryToolResult = (name: string, args: Record<string, unknown>, result: string) => {
    if (!name.includes("query_prometheus")) return;
    for (const candidate of extractDiscoveryCandidates(args, result, config.discoveryConfig.excludeServices)) {
      addCandidate(discoveredCandidates, candidate, config.discoveryConfig.excludeServices);
    }
  };

  // Always wrap the discovery tools — wrapToolsWithCallbacks applies
  // coercePrometheusArgs and coerceLokiArgs inside the execute path, and
  // those coercions MUST run even when no user-facing onToolCall callback
  // is wired (e.g., auto-discovery on cold start). `wrappedOnToolCall` can
  // be undefined; the wrapper handles that with optional chaining.
  // Pre-fetch datasource UIDs so the agent doesn't hallucinate them.
  // Returns both a prompt hint block and a short-name → real-UID map for
  // defensive coercion in the tool wrapper.
  const { hintBlock: datasourceHints, uidMap: datasourceUidMap } =
    await fetchDatasourceHintsForDiscover(discoveryTools);

  // Cap each tool result so accumulated history doesn't blow past the model's
  // context window and trigger "max_tokens must be at least 1, got -N" from
  // the OpenAI-compatible gateway. 0 disables the cap (legacy behaviour).
  const maxToolResultChars = config.discoveryConfig.maxToolResultChars > 0
    ? config.discoveryConfig.maxToolResultChars
    : undefined;
  const tools = wrapToolsWithCallbacks(
    discoveryTools,
    wrappedOnToolCall,
    "discovery",
    datasourceUidMap,
    maxToolResultChars,
    recordRawDiscoveryToolResult,
  );

  // Build recipe hints (skills + recipes). Datasource UIDs are passed
  // separately as a strict "CRITICAL" block in the agent's system prompt.
  let recipeAndSkillHints = "";
  if (config.skills && config.skills.length > 0) {
    const maxChars = config.maxCharsPerSkill ?? 2000;
    const skillSections = config.skills.map((s) => {
      const body = s.body.length > maxChars ? s.body.slice(0, maxChars) + "\n...[truncated]" : s.body;
      return `### ${wrapUntrusted("skill", s.title)}\n${wrapUntrusted("skill_body", body)}`;
    });
    recipeAndSkillHints += `## PRIORITY: Team Knowledge (Discovery Skills)\nThese skills describe services that CANNOT be found via standard K8s queries. You MUST run these discovery queries IN ADDITION to the standard recipes below.\n\n${skillSections.join("\n\n")}\n\n`;
  }
  recipeAndSkillHints += recipeHints;

  // For logging: combine both blocks so the debug log shows the full prompt
  const fullHints = datasourceHints + recipeAndSkillHints;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    throwIfDiscoveryAborted(config.abortSignal);
    const agent = createDiscoverAgent({
      model: config.model,
      tools,
      maxSteps,
      excludeServices: config.discoveryConfig.excludeServices,
      useQuirkHandling: true,
      datasourceUidHints: datasourceHints,
      discoveryRecipes: recipeAndSkillHints,
    });

    const discoverCallId = newCallId();
    const discoverPrompt = "Discover all monitored services using the available tools. Return the complete list as JSON.";
    const discoverStartMs = Date.now();
    const discoverToolCalls: ToolCallEvent[] = [];
    // Captured tool history with a larger per-result budget than the 500-char
    // observability slice. Used only by the stall-recovery follow-up prompt
    // when the agent's primary call returns 0 chars of synthesis text.
    const recoveryToolHistory: RecoveryToolEntry[] = [];
    logLlmCallStart({
      callId: discoverCallId,
      agent: "discover",
      phase: `attempt-${attempt}`,
      promptChars: discoverPrompt.length + fullHints.length,
      prompt: `${discoverPrompt}\n\n${fullHints}`,
    });

    try {
      const result = await runWithHardTimeout(config.llmCallMs, (abortSignal) =>
        agent.generate(discoverPrompt, {
          abortSignal,
          providerOptions: {
            "openai-compatible": { max_tokens: config.discoveryConfig.maxOutputTokens },
          },
          onStepFinish: (step: any) => {
            if (!step.toolResults?.length) return;
            for (const tr of step.toolResults) {
              try {
                const payload = tr.payload ?? tr;
                const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
                const nestedContent = payload.result?.content?.[0]?.text;
                const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
                const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                // JSON.stringify can throw on BigInt / circular / exotic return types.
                // Slice args/results to 500 chars to bound memory on long discovery runs.
                const argsStr = JSON.stringify(payload.args ?? {});
                recordRawDiscoveryToolResult(toolName, payload.args ?? {}, resultStr);
                const toolEvent: ToolCallEvent = {
                  tool: toolName,
                  argsChars: argsStr.length,
                  args: argsStr.slice(0, 500),
                  resultChars: resultStr.length,
                  result: resultStr.slice(0, 500),
                };
                discoverToolCalls.push(toolEvent);
                logToolCall(discoverCallId, "discover", toolEvent);
                recoveryToolHistory.push({
                  tool: toolName,
                  args: argsStr.slice(0, 500),
                  result: resultStr.slice(0, RECOVERY_TOOL_RESULT_CHARS),
                });
              } catch (err) {
                // Never let observability crash the discover step.
                logger.warn({ err }, "discover: onStepFinish failed to record tool call");
              }
            }
          }
        } as any),
        config.abortSignal,
      );

      const usage = (result as any).totalUsage ?? (result as any).usage;
      const inTok = usage?.inputTokens ?? 0;
      const outTok = usage?.outputTokens ?? 0;
      if (usage && config.onTokenUsage) {
        config.onTokenUsage({ inputTokens: inTok, outputTokens: outTok });
      }

      logLlmCall({
        callId: discoverCallId,
        agent: "discover",
        phase: `attempt-${attempt}`,
        promptChars: discoverPrompt.length + fullHints.length,
        prompt: `${discoverPrompt}\n\n${fullHints}`,
        responseChars: result.text?.length ?? 0,
        response: result.text,
        inputTokens: inTok,
        outputTokens: outTok,
        durationMs: Date.now() - discoverStartMs,
        toolCalls: discoverToolCalls,
      });

      // Reasoning models (gpt-oss) sometimes emit JSON into `reasoning_content`
      // instead of `content`. The AI SDK surfaces that as `reasoningText`.
      // Try the regular text first; fall back to reasoning text if empty.
      const reasoningText = (result as any).reasoningText ?? (result as any).reasoning;
      const primary =
        tryParseDiscoverResponse(result.text) ??
        tryParseDiscoverResponse(typeof reasoningText === "string" ? reasoningText : undefined);
      if (primary) {
        return mergeCandidatesIntoDiscoveryResult(
          primary,
          discoveredCandidates,
          config.discoveryConfig.excludeServices,
        );
      }

      // Stall recovery: gpt-oss-120b on saturated context sometimes stops
      // calling tools and emits either 0 chars or a syntactically valid but
      // unusable empty payload (`[]`). The prepareStep wind-down can't help
      // when the model voluntarily exits at step 6-9, well before maxSteps-2
      // fires the wind-down. Manually invoke a follow-up turn with the
      // captured tool data inline and toolChoice forced off.
      if (recoveryToolHistory.length > 0) {
        const recoveryCallId = newCallId();
        const recoveryStartMs = Date.now();
        const historyBlock = formatRecoveryToolHistory(recoveryToolHistory);
        const recoveryPrompt = `${STALL_RECOVERY_PROMPT_HEADER}\n\n${historyBlock}`;
        logger.warn(
          { attempt, toolCallCount: recoveryToolHistory.length, responseChars: result.text?.length ?? 0, recoveryCallId },
          "discovery: unusable synthesis after tool-using session — invoking stall-recovery",
        );
        logLlmCallStart({
          callId: recoveryCallId,
          agent: "discover",
          phase: `attempt-${attempt}-recovery`,
          promptChars: recoveryPrompt.length,
          prompt: recoveryPrompt,
        });
        try {
          const recoveryResult = await withLlmRetry(
            () => runWithHardTimeout(RECOVERY_TIMEOUT_MS, (abortSignal) => agent.generate(recoveryPrompt, {
              abortSignal,
              providerOptions: {
                "openai-compatible": {
                  max_tokens: config.discoveryConfig.maxOutputTokens,
                  reasoning_effort: "low",
                },
              },
              toolChoice: "none",
            } as any), config.abortSignal),
            discoverRetryConfig(config),
          );

          const recoveryUsage = (recoveryResult as any).totalUsage ?? (recoveryResult as any).usage;
          const recoveryInTok = recoveryUsage?.inputTokens ?? 0;
          const recoveryOutTok = recoveryUsage?.outputTokens ?? 0;
          if (recoveryUsage && config.onTokenUsage) {
            config.onTokenUsage({ inputTokens: recoveryInTok, outputTokens: recoveryOutTok });
          }
          logLlmCall({
            callId: recoveryCallId,
            agent: "discover",
            phase: `attempt-${attempt}-recovery`,
            promptChars: recoveryPrompt.length,
            prompt: recoveryPrompt,
            responseChars: recoveryResult.text?.length ?? 0,
            response: recoveryResult.text,
            inputTokens: recoveryInTok,
            outputTokens: recoveryOutTok,
            durationMs: Date.now() - recoveryStartMs,
            toolCalls: [],
          });

          const recoveryReasoning = (recoveryResult as any).reasoningText ?? (recoveryResult as any).reasoning;
          const recovered =
            tryParseDiscoverResponse(recoveryResult.text) ??
            tryParseDiscoverResponse(typeof recoveryReasoning === "string" ? recoveryReasoning : undefined);
          if (recovered) {
            const completed = mergeCandidatesIntoDiscoveryResult(
              recovered,
              discoveredCandidates,
              config.discoveryConfig.excludeServices,
            );
            logger.info(
              { attempt, recoveredServiceCount: completed.services.length },
              "discovery: stall-recovery succeeded",
            );
            return completed;
          }
          logger.warn(
            { attempt, recoveryResponseChars: recoveryResult.text?.length ?? 0 },
            "discovery: stall-recovery returned unparseable output",
          );
        } catch (err) {
          const recoveryMessage = err instanceof Error ? err.message : String(err);
          logLlmCall({
            callId: recoveryCallId,
            agent: "discover",
            phase: `attempt-${attempt}-recovery`,
            promptChars: recoveryPrompt.length,
            prompt: recoveryPrompt,
            responseChars: 0,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - recoveryStartMs,
            toolCalls: [],
            error: recoveryMessage,
          });
          logger.warn({ attempt, err: recoveryMessage }, "discovery: stall-recovery threw");
          if (err instanceof LlmUnavailableError) throw err;
        }
      }

      const respLen = result.text?.length ?? 0;
      const first200 = result.text?.slice(0, 200) ?? "";
      const last200 = result.text?.slice(-200) ?? "";
      logger.warn(
        { attempt, maxRetries: MAX_RETRIES, responseChars: respLen, first200, last200 },
        `discovery: parse failed on ${respLen}-char response (attempt ${attempt}/${MAX_RETRIES})`,
      );
      config.onRetry?.(attempt, MAX_RETRIES, "parse failed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logLlmCall({
        callId: discoverCallId,
        agent: "discover",
        phase: `attempt-${attempt}`,
        promptChars: discoverPrompt.length + fullHints.length,
        prompt: `${discoverPrompt}\n\n${fullHints}`,
        responseChars: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - discoverStartMs,
        toolCalls: discoverToolCalls,
        error: message,
      });
      if (isLlmTimeoutError(err)) {
        if (discoveredCandidates.size > 0) {
          logger.warn(
            { attempt, candidateServiceCount: discoveredCandidates.size },
            "discovery: primary LLM timed out after tool data was captured — returning deterministic candidates instead of replaying discovery",
          );
          return mergeCandidatesIntoDiscoveryResult(
            { services: [], globalProbeRules: [] },
            discoveredCandidates,
            config.discoveryConfig.excludeServices,
          );
        }
        logger.warn(
          { attempt, err: message },
          "discovery: primary LLM timed out before usable tool data was captured — failing fast",
        );
        throw err;
      }
      logger.warn({ attempt, err: message }, "discovery attempt failed");
      // Tool-less recovery still uses withLlmRetry. Do not send those
      // sustained upstream failures through the outer parse-retry loop.
      if (err instanceof LlmUnavailableError) throw err;
      if (attempt === MAX_RETRIES) throw err;
      // Primary path is no longer wrapped in withLlmRetry, so transient
      // upstream errors fall to the outer loop. Back off here so we don't
      // hammer a flapping gateway in a tight 1-2-3 burst. Honor the caller
      // abort signal so cancellation isn't delayed by up to 30s of sleep.
      const baseDelay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
      const jitter = Math.random() * 0.3 * baseDelay;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, baseDelay + jitter);
        const onAbort = () => {
          clearTimeout(t);
          reject(createDiscoveryAbortError(config.abortSignal?.reason));
        };
        if (config.abortSignal) {
          if (config.abortSignal.aborted) { clearTimeout(t); onAbort(); return; }
          config.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  }

  logger.error(
    { maxRetries: MAX_RETRIES },
    "discovery: agent returned no parseable services after all retries — returning empty list (likely causes: LLM produced empty array, wrapped result in unexpected shape, or exhausted iterations without JSON output)",
  );
  if (discoveredCandidates.size > 0) {
    logger.warn(
      { candidateServiceCount: discoveredCandidates.size },
      "discovery: returning deterministic candidates after all LLM parse attempts failed",
    );
    return mergeCandidatesIntoDiscoveryResult(
      { services: [], globalProbeRules: [] },
      discoveredCandidates,
      config.discoveryConfig.excludeServices,
    );
  }
  return { services: [], globalProbeRules: [] };
}

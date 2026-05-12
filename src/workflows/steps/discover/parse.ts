/**
 * Parsing + Zod validation of the discover agent's response.
 *
 * The agent emits a JSON envelope `{ services, globalProbeRules }` (or sometimes
 * a bare services array on legacy responses). This module:
 *   - parses the JSON text or reasoning_content fallback (gpt-oss quirk)
 *   - Zod-validates each rule against `ProbeMetricRuleSchema`
 *   - drops rules with unsafe names (`:` is reserved for scheduler state-key encoding)
 *
 * `backfillServiceAvailability` / `backfillGlobalAvailabilityRules` were
 * removed in 2026-05 — 51 stress iters showed 0 fires; the model emits
 * availability rules reliably on its own.
 *
 * Pure transformations — no I/O, no orchestration state.
 */

import { safeJsonParse } from "../../../agents/shared/processors.js";
import { getReasoningText } from "../../../agents/shared/llm-result.js";
import { quirkHit } from "../../../agents/shared/quirk-telemetry.js";
import type { ServiceConfig, ProbeMetricRule } from "../../../config/schema.js";
import { ProbeMetricRuleSchema } from "../../../config/schema.js";
import { createLogger } from "../../../logger.js";
import type { DiscoverStepResult } from "./candidates.js";

const logger = createLogger("discover");

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
 * Detect workload kind from `metrics[0].query` so we can emit a
 * pod_restarts rule with the correct selector. Returns `{ kind, name }`
 * where `name` is the workload label value. Returns null when the query
 * shape doesn't reveal a workload.
 */
function detectWorkloadFromQuery(query: string): { kind: "deployment" | "statefulset"; name: string } | null {
  const dep = /\bdeployment="([^"\\]+)"/.exec(query);
  if (dep && dep[1]) return { kind: "deployment", name: dep[1] };
  const sts = /\bstatefulset="([^"\\]+)"/.exec(query);
  if (sts && sts[1]) return { kind: "statefulset", name: sts[1] };
  return null;
}

/**
 * Derive a per-service `pod=~"<workload>-.*$"`-style selector from log labels
 * when the LLM's metrics[0] shape (e.g. `up{job="<svc>"}`) doesn't reveal a
 * kube-state workload kind. Priority order matches discover-prompt
 * Layer 6.3.B priority ladder:
 *   1. container — exact kube_pod_container_status_restarts_total label
 *   2. namespace + workload-name pod regex (anchored)
 *
 * Returns the selector body (without the surrounding `{}`), or null when
 * no safe selector can be built. The anchored `$` on the pod regex is
 * critical — without it, `pod=~"api-.*"` false-matches `api-internal-*`.
 */
function deriveRestartSelectorFromLogLabels(
  serviceName: string,
  rawLogLabels: unknown,
): string | null {
  if (!rawLogLabels || typeof rawLogLabels !== "object") return null;
  const labels = rawLogLabels as Record<string, unknown>;
  const container = typeof labels["container"] === "string" ? labels["container"] : undefined;
  const namespace = typeof labels["namespace"] === "string" ? labels["namespace"] : undefined;

  // Priority 1: container (Layer 6.3.B priority 2).
  if (container) {
    const parts = [`container="${container.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`];
    if (namespace) parts.unshift(`namespace="${namespace.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`);
    return parts.join(",");
  }
  // Priority 2: namespace + anchored pod regex (Layer 6.3.B priority 3).
  if (namespace) {
    return `namespace="${namespace.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}",pod=~"${serviceName}-.+$"`;
  }
  return null;
}

/**
 * Deterministic pod_restarts backfill. Mirrors the discover-prompt's
 * Layer 6.3.B priority ladder using the kube-state label (`deployment`
 * or `statefulset`). For statefulsets the selector is
 * `pod=~"<name>-[0-9]+$"` (ordinal-anchored).
 *
 * Only fires when the LLM didn't emit pod_restarts AND `metrics[0]`
 * reveals a deployment or statefulset workload. Bare-metal Consul services
 * and DaemonSets fall through and leave the rule unset.
 */
function backfillPodRestarts(
  serviceName: string,
  rawMetrics: unknown,
  rawLogLabels: unknown,
  probeRules: ProbeMetricRule[],
): void {
  if (probeRules.some((r) => r.name === "pod_restarts")) return;
  if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) return;
  const first = rawMetrics[0] as Record<string, unknown> | undefined;
  const query = first && typeof first.query === "string" ? first.query.trim() : "";
  if (!query) return;

  let selector: string | null = null;
  let kind: string = "unknown";
  // Priority 1: workload-kind selector from kube_*_status_* metric query.
  const workload = detectWorkloadFromQuery(query);
  if (workload) {
    kind = workload.kind;
    selector = workload.kind === "deployment"
      ? `{deployment="${workload.name}"}`
      : `{pod=~"${workload.name}-[0-9]+$"}`;
  } else {
    // Priority 2 (iter 9): when the LLM picked an `up{job=...}`-style metric
    // (no kube-state label), fall back to log-label-derived selector. This
    // recovers `pod_restarts` coverage on the LLM-bad-seed rounds where the
    // discover agent took the simpler `up{}` path instead of kube-state.
    const bodyFromLabels = deriveRestartSelectorFromLogLabels(serviceName, rawLogLabels);
    if (bodyFromLabels) {
      kind = "log-label-derived";
      selector = `{${bodyFromLabels}}`;
    }
  }

  if (!selector) return;
  probeRules.push({
    name: "pod_restarts",
    query: `rate(kube_pod_container_status_restarts_total${selector}[5m])`,
    threshold: { op: "gt", value: 0.033 },
    consecutiveTicks: 2,
    source: "metrics",
  });
  logger.debug({ service: serviceName, selector, kind }, "discovery: backfilled pod_restarts rule");
  quirkHit("backfill:pod-restarts", { service: serviceName, kind });
}

/**
 * Deterministic log_errors backfill. Reuses the LLM-emitted `logLabels`
 * map and wraps it in the standard Loki shape (same template as the
 * discover-prompt Layer 6.3.C). Only fires when the LLM omitted log_errors
 * AND emitted at least one logLabel.
 */
function backfillLogErrors(
  serviceName: string,
  rawLogLabels: unknown,
  probeRules: ProbeMetricRule[],
): void {
  if (probeRules.some((r) => r.name === "log_errors")) return;
  if (!rawLogLabels || typeof rawLogLabels !== "object") return;
  const entries = Object.entries(rawLogLabels as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  if (entries.length === 0) return;
  const selector = entries
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`)
    .join(",");
  probeRules.push({
    name: "log_errors",
    query: `sum(count_over_time({${selector}} |= \`error\` or \`fatal\` [15m]))`,
    threshold: { op: "gt", value: 75 },
    consecutiveTicks: 2,
    source: "logs",
  });
  logger.debug({ service: serviceName, selector }, "discovery: backfilled log_errors rule from logLabels");
  quirkHit("backfill:log-errors", { service: serviceName });
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
    backfillPodRestarts(svc.name, svc.metrics, svc.logLabels, probeRules);
    backfillLogErrors(svc.name, svc.logLabels, probeRules);
    out.push({ ...(svc as ServiceConfig), probeRules });
  }
  return out;
}

function tryParseDiscoverResponse(text: string | undefined): DiscoverStepResult | null {
  if (!text) return null;
  const parsed = safeJsonParse(text);
  if (Array.isArray(parsed) && parsed.length > 0) {
    const services = validateDiscoveredServices(parsed);
    const globalProbeRules: ProbeMetricRule[] = [];
    return { services, globalProbeRules };
  }
  if (parsed && typeof parsed === "object") {
    const rawServices = Array.isArray((parsed as { services?: unknown }).services) ? (parsed as { services: unknown[] }).services : [];
    const rawGlobals = Array.isArray((parsed as { globalProbeRules?: unknown }).globalProbeRules) ? (parsed as { globalProbeRules: unknown[] }).globalProbeRules : [];
    const globalProbeRules = validateDiscoveredRules(rawGlobals, "globalProbeRules");
    const services = validateDiscoveredServices(rawServices);
    if (services.length > 0 || globalProbeRules.length > 0) {
      return { services, globalProbeRules };
    }
  }
  return null;
}

/**
 * Reasoning models (gpt-oss) sometimes emit JSON into `reasoning_content` instead
 * of `content`. The AI SDK surfaces that as `reasoningText`. Try `text` first;
 * fall back to reasoning text if empty.
 */
export function parsePrimaryOrReasoning(result: unknown): DiscoverStepResult | null {
  const r = result as { text?: string };
  const primary = tryParseDiscoverResponse(r.text);
  if (primary) return primary;
  const reasoning = getReasoningText(result);
  const reasoningParse = tryParseDiscoverResponse(reasoning);
  if (reasoningParse) {
    // Fallback fired — text didn't yield a result but reasoningText did.
    // Hit counter only when the fallback is what actually rescued the parse.
    quirkHit("reasoning-fallback", { textLen: r.text?.length ?? 0, reasoningLen: reasoning?.length ?? 0 });
  }
  return reasoningParse;
}

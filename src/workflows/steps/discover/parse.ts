/**
 * Parsing + Zod validation of the discover agent's response.
 *
 * The agent emits a JSON envelope `{ services, globalProbeRules }` (or sometimes
 * a bare services array on legacy responses). This module:
 *   - parses the JSON text or reasoning_content fallback (gpt-oss quirk)
 *   - Zod-validates each rule against `ProbeMetricRuleSchema`
 *   - drops rules with unsafe names (`:` is reserved for scheduler state-key encoding)
 *   - deterministically backfills `service_availability` per-service when the
 *     LLM forgot, and a global `{label}_availability` rule when N services
 *     share a `up{label}` pattern
 *
 * Pure transformations — no I/O, no orchestration state.
 */

import { safeJsonParse } from "../../../agents/shared/processors.js";
import { getReasoningText } from "../../../agents/shared/llm-result.js";
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

const PROM_LABEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
    const rawServices = Array.isArray((parsed as { services?: unknown }).services) ? (parsed as { services: unknown[] }).services : [];
    const rawGlobals = Array.isArray((parsed as { globalProbeRules?: unknown }).globalProbeRules) ? (parsed as { globalProbeRules: unknown[] }).globalProbeRules : [];
    const globalProbeRules = validateDiscoveredRules(rawGlobals, "globalProbeRules");
    const services = validateDiscoveredServices(rawServices);
    backfillGlobalAvailabilityRules(services, globalProbeRules);
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
  return (
    tryParseDiscoverResponse(r.text) ??
    tryParseDiscoverResponse(getReasoningText(result))
  );
}

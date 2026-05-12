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

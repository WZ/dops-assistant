/**
 * scan-service-override — per-service overrides for the proactive scan.
 *
 * Shape (JSON-encoded in db.service_metadata.scan_override):
 *   { disabled: true }        → skip this service entirely (probe + dispatch)
 *   { rules: ProbeMetricRule[] } → use THESE rules instead of the global set
 *   null / absent             → use global rules (default)
 *
 * Why replace, not merge? Merge semantics get ambiguous fast — "inherit
 * global but change the threshold on this one rule" requires rule identity
 * decisions, and operators who want fine-grained override are probably
 * writing fully-custom rules anyway. Replace is simpler and predictable.
 */

import { z } from "zod";
import { createLogger } from "../logger.js";
import { validateRules, type ValidationError } from "./scan-rule-validator.js";
import type { ProbeMetricRule } from "../config/schema.js";

const logger = createLogger();

export interface ScanServiceOverride {
  disabled?: boolean;
  rules?: ProbeMetricRule[];
}

/**
 * Zod shape for the CRUD endpoints. `.strict()` rejects unknown fields so
 * API misuse produces a 400 instead of silently ignoring typos. Note: we
 * re-validate `rules` via `validateRules()` (richer errors + name-uniqueness
 * + {service} check) — this only enforces the envelope.
 */
export const ScanServiceOverrideBodySchema = z.object({
  disabled: z.boolean().optional(),
  rules: z.array(z.unknown()).optional(),
}).strict();

export interface OverrideValidationResult {
  ok: boolean;
  errors: ValidationError[];
  override: ScanServiceOverride | null;
}

/**
 * Validate an incoming override body. Returns a normalized ScanServiceOverride
 * with rules run through validateRules() (so defaults are applied). Empty
 * override `{}` is rejected — if the operator wants to clear the override,
 * they should DELETE the endpoint, not PUT an empty body.
 */
export function validateOverride(input: unknown): OverrideValidationResult {
  const parsed = ScanServiceOverrideBodySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "(body)",
        message: i.message,
      })),
      override: null,
    };
  }

  const body = parsed.data;
  if (body.disabled === undefined && body.rules === undefined) {
    return {
      ok: false,
      errors: [{ path: "(body)", message: "Override must specify `disabled` or `rules` (or both). To clear, use DELETE." }],
      override: null,
    };
  }

  // `{ disabled: false }` with no rules is a no-op: the absence of an override
  // already means "scan this service using global rules". Accepting it only
  // clutters the DB with overrides that don't do anything and confuses the UI
  // ("this service has an override!" — but the override means nothing). Force
  // the operator to DELETE instead, so intent is explicit.
  if (body.disabled === false && body.rules === undefined) {
    return {
      ok: false,
      errors: [{ path: "disabled", message: "`{ disabled: false }` alone is a no-op. To restore default scanning, DELETE the override instead." }],
      override: null,
    };
  }

  // `rules: []` with no disabled flag is ambiguous: did the operator mean
  // "scan this service with zero rules" (which the probe currently treats as
  // "fall back to globals") or "disable scanning"? Refuse to guess. If they
  // want zero scanning, `{ disabled: true }` is the explicit option. If they
  // want to clear the override, DELETE is the explicit option.
  if (Array.isArray(body.rules) && body.rules.length === 0 && body.disabled === undefined) {
    return {
      ok: false,
      errors: [{ path: "rules", message: "`rules: []` is ambiguous. Use `{ disabled: true }` to skip this service, or DELETE to restore global rules." }],
      override: null,
    };
  }

  const out: ScanServiceOverride = {};
  if (body.disabled !== undefined) out.disabled = body.disabled;

  if (body.rules !== undefined) {
    const result = validateRules(body.rules);
    if (!result.ok) return { ok: false, errors: result.errors, override: null };
    out.rules = result.rules;
  }

  return { ok: true, errors: [], override: out };
}

/**
 * Parse a stored override JSON blob. Returns null on parse / shape error so
 * the caller falls back to the global rule set.
 *
 * We RE-VALIDATE shape on read, same reasoning as scan-settings'
 * parseProbeMetricsOverride: sqlite-CLI edits, schema drift across versions,
 * and future-me writing a field this version doesn't understand can all
 * produce rows that look like objects but crash anomaly-probe when it reads
 * `rule.query`. Validating here keeps the probe's hot path dumb.
 */
export function parseOverride(raw: string | null): ScanServiceOverride | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err, rawPreview: raw.slice(0, 100) }, "scan-service-override: failed to parse stored JSON, falling back to global");
    return null;
  }

  const envelope = ScanServiceOverrideBodySchema.safeParse(parsed);
  if (!envelope.success) {
    logger.warn({
      rawPreview: raw.slice(0, 200),
      errors: envelope.error.issues.slice(0, 3).map((i) => ({ path: i.path.join("."), message: i.message })),
    }, "scan-service-override: stored override failed envelope validation, falling back to global");
    return null;
  }

  const body = envelope.data;
  const out: ScanServiceOverride = {};
  if (body.disabled !== undefined) out.disabled = body.disabled;

  if (body.rules !== undefined) {
    // Rules stored in the DB were validated on write, but re-validate anyway
    // — an old row from a previous schema or a manual INSERT could slip
    // through. On malformed rules, return null (fall back to global rather
    // than mix valid `disabled` with missing rules, which would produce
    // confusing probe behavior).
    const result = validateRules(body.rules);
    if (!result.ok) {
      logger.warn({
        rawPreview: raw.slice(0, 200),
        errors: result.errors.slice(0, 3),
      }, "scan-service-override: stored rules failed re-validation, falling back to global");
      return null;
    }
    out.rules = result.rules;
  }

  return out;
}

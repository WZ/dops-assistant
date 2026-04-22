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
 * Parse a stored override JSON blob. Returns null on parse error (operator
 * corrupted the DB manually, or a schema drift happened). Log once — we
 * don't want to spam on every tick reading the same broken row.
 */
export function parseOverride(raw: string | null): ScanServiceOverride | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as ScanServiceOverride;
    }
    return null;
  } catch (err) {
    logger.warn({ err, rawPreview: raw.slice(0, 100) }, "scan-service-override: failed to parse stored JSON, falling back to global");
    return null;
  }
}

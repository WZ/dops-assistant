/**
 * scan-rule-validator — structural + semantic validation for operator-authored
 * probe rules.
 *
 * Runs server-side on every PUT /api/scan/settings that includes a `rules`
 * field. The goal: give the operator a loud 400 with actionable messages
 * BEFORE any rule hits the DB, instead of a silent soft-break where the
 * scheduler starts but never trips (empty vector, missing {service}, etc.).
 *
 * What this file does NOT do:
 *  - Dry-run the query against Prometheus (that's POST /api/scan/rules/test).
 *  - Semantic check (does the query return a scalar-per-service?) — same.
 * This is the cheap, deterministic, sync pass. The slow, Prometheus-dependent
 * pass lives in the test endpoint because it's opt-in.
 */

import { z } from "zod";

// Keep this schema shape in lockstep with ProbeMetricRuleSchema in
// src/config/schema.ts. Ideally we'd import that, but `min(1)` on name
// + the {service}-template refinement are GUI-editor-specific — not
// something we want to force on config.yaml.
const ThresholdSchema = z.object({
  op: z.enum(["gt", "lt", "gte", "lte"]),
  value: z.number(),
});

const RuleSchema = z.object({
  // Names cannot contain ':' — the scheduler's consecutiveState Map keys by
  // `"{service}:{ruleName}"` and splits on lastIndexOf(":"). A rule name with
  // an embedded colon (e.g. "db:slow") would silently corrupt the per-rule
  // state reset during reload diffs. Rather than refactor the key encoding
  // now, forbid the delimiter at the validator.
  name: z.string()
    .min(1, "name must be non-empty")
    .regex(/^[^:]+$/, "name must not contain ':' (reserved for internal state-key encoding)"),
  query: z.string().min(1, "query must be non-empty"),
  threshold: ThresholdSchema,
  consecutiveTicks: z.number().int().min(1, "consecutiveTicks must be >= 1").default(1),
}).strict();

const RulesArraySchema = z.array(RuleSchema);

export interface ValidationError {
  path: string;        // "rules[2].name" etc.
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /** Parsed + defaulted rules. Populated even when ok=false for diagnostics,
   *  but caller should only write on ok=true. */
  rules: z.infer<typeof RulesArraySchema>;
}

/**
 * Validate an operator-submitted rules array. Cheap and deterministic — no
 * I/O, no Prometheus. Callers use the dry-run endpoint separately to confirm
 * the query actually returns sensible data.
 */
export function validateRules(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  // 1. Shape validation — Zod does the heavy lifting.
  const parsed = RulesArraySchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        path: issue.path.length > 0 ? `rules.${issue.path.join(".")}` : "rules",
        message: issue.message,
      });
    }
    return { ok: false, errors, rules: [] };
  }

  const rules = parsed.data;

  // 2. Name uniqueness — rule identity is the name. Duplicate names would
  // clobber each other in the consecutive-state Map and produce nondeterministic
  // scoring.
  const seenNames = new Set<string>();
  rules.forEach((rule, idx) => {
    if (seenNames.has(rule.name)) {
      errors.push({
        path: `rules[${idx}].name`,
        message: `Duplicate rule name: "${rule.name}". Each rule must have a unique name.`,
      });
    }
    seenNames.add(rule.name);
  });

  // 3. Query template check — the probe substitutes `{service}` with the
  // sanitized service name. A query without `{service}` would run against
  // every service identically, wasting calls and producing the same result
  // N times. Could be deliberate (e.g., global aggregate), but this is the
  // editor-default rules editor, and allowing global queries adds complexity
  // (how are they scored? per-service or stack-wide?) without a real user
  // story. Reject for now; revisit if someone actually asks.
  rules.forEach((rule, idx) => {
    if (!rule.query.includes("{service}")) {
      errors.push({
        path: `rules[${idx}].query`,
        message: `Query must include the "{service}" placeholder so the probe can substitute per-service. Example: 'up{service="{service}"}'.`,
      });
    }
  });

  return { ok: errors.length === 0, errors, rules };
}

/**
 * Shared helpers for threading learned `incident_patterns` rows into the
 * planner + synthesis prompts. Patterns come from user thumbs-up feedback
 * (see `routes.ts` POST /api/investigations/:id/feedback) and live in the
 * `incident_patterns` table — symptom + root cause + recommended actions
 * captured from past useful RCAs on the same service.
 *
 * The shape returned by `Database.findSimilarPatterns` is replicated here
 * as a structural type so this module has zero import dependency on the
 * server package — it stays callable from any workflow step.
 */

export interface IncidentPatternRow {
  id: string;
  service: string;
  symptom: string;
  root_cause: string;
  severity: string;
  recommended_actions: string | null;
  created_at: string;
}

/** Cap each text field so a runaway pattern can't blow the prompt budget. */
const MAX_FIELD_CHARS = 500;

function clip(s: string | null | undefined, max = MAX_FIELD_CHARS): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Render up to N pattern rows as a labeled block for inclusion in an LLM
 * prompt. Returns `""` when the array is empty so callers can `.filter(Boolean)`
 * on a join list without an extra null check.
 *
 * Format:
 *   Past useful patterns for {service}:
 *
 *   [pat_01XYZ — high severity, 2026-04-21]
 *   SYMPTOM: ...
 *   ROOT CAUSE: ...
 *   ACTIONS: ...
 *
 *   [pat_01ABC — medium severity, 2026-04-15]
 *   ...
 *
 * The header tells the model these are PRIORS, not current evidence —
 * the calibration instruction (caller adds its own line: "if symptom matches,
 * bump confidence and name the pattern id") completes the framing.
 */
export function formatPatterns(service: string, patterns: IncidentPatternRow[]): string {
  if (!patterns.length) return "";
  const date = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
  };
  const blocks = patterns.map((p) => {
    const header = `[${p.id} — ${p.severity} severity, ${date(p.created_at)}]`;
    const lines = [
      header,
      `SYMPTOM: ${clip(p.symptom)}`,
      `ROOT CAUSE: ${clip(p.root_cause)}`,
    ];
    if (p.recommended_actions) lines.push(`ACTIONS: ${clip(p.recommended_actions)}`);
    return lines.join("\n");
  });
  return `Past useful patterns for ${service}:\n\n${blocks.join("\n\n")}`;
}

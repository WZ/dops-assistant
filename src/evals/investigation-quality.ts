/**
 * Investigation quality evaluation module.
 *
 * Provides heuristic scoring for RCA reports and an optional model-graded
 * scoring path for future integration. The heuristic scorer is always
 * available and requires no LLM call.
 */

import type { RcaReport } from "../types/rca-types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QualityScore {
  conclusiveness: number; // 0-1
  evidenceSupport: number; // 0-1
  actionability: number; // 0-1
  passed: boolean;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const THRESHOLD = 0.5;

// Patterns that indicate a weak / inconclusive root cause statement
const WEAK_ROOT_CAUSE_PATTERNS: RegExp[] = [
  /unable to determine/i,
  /insufficient data/i,
  /no clear/i,
  /cannot determine/i,
  /could not determine/i,
  /unclear/i,
  /unknown cause/i,
];

// ── Heuristic scorers ─────────────────────────────────────────────────────────

/**
 * Score conclusiveness based on the rootCause field.
 *
 * Rules:
 *   - Very short (<20 chars) → 0.1
 *   - Matches a weak pattern → 0.3
 *   - Otherwise → 0.8
 */
function scoreConclusiveness(report: RcaReport): number {
  const rc = (report.rootCause ?? "").trim();

  if (rc.length < 20) return 0.1;

  for (const pattern of WEAK_ROOT_CAUSE_PATTERNS) {
    if (pattern.test(rc)) return 0.3;
  }

  return 0.8;
}

/**
 * Score evidence support based on whether metric/log observations are present.
 *
 * Base score: 0.3
 * +0.3 if report.evidence.metrics has at least one entry
 * +0.3 if report.evidence.logs has at least one entry
 */
function scoreEvidenceSupport(report: RcaReport): number {
  let score = 0.3;

  if (report.evidence?.metrics?.length > 0) score += 0.3;
  if (report.evidence?.logs?.length > 0) score += 0.3;

  return Math.min(score, 1.0);
}

/**
 * Score actionability based on the number of recommended actions.
 *
 *   0 recommendations → 0.1
 *   1 recommendation  → 0.5
 *   2+                → 0.8
 */
function scoreActionability(report: RcaReport): number {
  const count = report.recommendedActions?.length ?? 0;

  if (count === 0) return 0.1;
  if (count === 1) return 0.5;
  return 0.8;
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Evaluate the quality of an RCA report.
 *
 * When an `evaluator` callback is provided, the function sends a structured
 * prompt to it and uses the returned score (model-graded path). If the
 * evaluator call fails or is not provided, heuristic scoring is used instead.
 *
 * @param report     The RCA report to evaluate.
 * @param evaluator  Optional model-graded evaluator. Receives a prompt string
 *                   and must return a JSON string with { conclusiveness,
 *                   evidenceSupport, actionability } (all 0-1 floats).
 */
export async function evaluateReportQuality(
  report: RcaReport,
  evaluator?: (prompt: string) => Promise<string>,
): Promise<QualityScore> {
  // Optional model-graded path
  if (evaluator) {
    try {
      const prompt = buildEvaluatorPrompt(report);
      const raw = await evaluator(prompt);
      const parsed = JSON.parse(raw) as Partial<QualityScore>;

      const conclusiveness = clamp(Number(parsed.conclusiveness ?? NaN));
      const evidenceSupport = clamp(Number(parsed.evidenceSupport ?? NaN));
      const actionability = clamp(Number(parsed.actionability ?? NaN));

      if (isFinite(conclusiveness) && isFinite(evidenceSupport) && isFinite(actionability)) {
        const passed =
          conclusiveness >= THRESHOLD &&
          evidenceSupport >= THRESHOLD &&
          actionability >= THRESHOLD;

        return { conclusiveness, evidenceSupport, actionability, passed };
      }
    } catch {
      // Fall through to heuristic scoring
    }
  }

  // Heuristic scoring (always available)
  const conclusiveness = scoreConclusiveness(report);
  const evidenceSupport = scoreEvidenceSupport(report);
  const actionability = scoreActionability(report);

  const passed =
    conclusiveness >= THRESHOLD &&
    evidenceSupport >= THRESHOLD &&
    actionability >= THRESHOLD;

  return { conclusiveness, evidenceSupport, actionability, passed };
}

/**
 * Determine whether synthesis should be retried based on quality scores.
 * Returns true if the report did not pass the quality threshold.
 */
export function shouldRetrySynthesis(scores: QualityScore): boolean {
  return !scores.passed;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function buildEvaluatorPrompt(report: RcaReport): string {
  return [
    "Evaluate the quality of the following root cause analysis report.",
    "Return JSON with three float fields (0-1 each):",
    "  conclusiveness: How clearly and specifically the root cause is identified",
    "  evidenceSupport: How well the evidence supports the root cause",
    "  actionability: How actionable the recommendations are",
    "",
    "Report summary:",
    `  rootCause: ${report.rootCause}`,
    `  recommendedActions: ${JSON.stringify(report.recommendedActions)}`,
    `  evidence.metrics count: ${report.evidence?.metrics?.length ?? 0}`,
    `  evidence.logs count: ${report.evidence?.logs?.length ?? 0}`,
    `  confidence: ${report.confidence}`,
    "",
    "Return only a JSON object, no explanation.",
  ].join("\n");
}

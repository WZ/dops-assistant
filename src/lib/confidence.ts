/**
 * Confidence-score scale normalization.
 *
 * `confidenceScore` is meant to be a 0–1 fraction, but the synthesis LLM is
 * inconsistent: some completions emit `0.9`, others `90` (or `95.00`) on a
 * 0–100 scale. Stored unnormalized, the 0–100 values render as nonsense once a
 * consumer multiplies by 100 (e.g. `90 * 100 = 9000%`).
 *
 * These helpers coerce either scale to a single canonical form. Normalize at
 * the source so new reports store a 0–1 fraction, and use these defensively at
 * display sites so reports already persisted on the wrong scale still render
 * sensibly.
 */

/** Coerce a confidence score (0–1 fraction OR 0–100 percentage) to a 0–1
 *  fraction, clamped to [0, 1]. `null`/`undefined`/`NaN` → 0. A value `> 1` is
 *  assumed to be on the 0–100 scale and divided by 100. */
export function confidenceFraction(raw: number | null | undefined): number {
  if (raw == null || Number.isNaN(raw)) return 0;
  const fraction = raw > 1 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, fraction));
}

/** Whole-number percentage (0–100) for display, from either input scale. */
export function confidencePercent(raw: number | null | undefined): number {
  return Math.round(confidenceFraction(raw) * 100);
}

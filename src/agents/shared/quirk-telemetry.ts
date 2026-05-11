/**
 * Hit-counter for gpt-oss-120b quirk defenses.
 *
 * Background: the codebase carries ~1,080 LOC of compensating code across
 * ~14 files that defends against specific gpt-oss-120b failure modes
 * (stall recovery, JSON truncation, reasoning_content fallback, tool-arg
 * coercion, datasource UID hallucination, probe-rule backfill, etc).
 * Some of those defenses may no longer be needed if the model has improved
 * or our usage has shifted. We don't currently know which.
 *
 * This module gives each defense a hit counter so we can find out:
 *   - call `quirkHit("category:name", optional-meta)` from inside the hot
 *     path of each defense, only when the defense actually fired
 *   - inspect counts via `getQuirkHits()` or `GET /api/health/quirks`
 *   - quirks that show 0 hits over a long observation window are
 *     deletion candidates (after a confirming ablation eval)
 *
 * Counters are in-process — they reset on server restart. That's
 * intentional: hits are aggregated daily by a cron that hits the endpoint
 * and persists to a CSV, then calls `resetQuirkHits()`.
 *
 * All call sites MUST be wrapped in try/catch (or use the safe variant in
 * this file). Observability NEVER breaks the hot path.
 */

const HITS = new Map<string, number>();
const LAST_META = new Map<string, unknown>();
const FIRST_SEEN = new Map<string, number>();
const LAST_SEEN = new Map<string, number>();

export interface QuirkHitRecord {
  count: number;
  firstSeenMs: number;
  lastSeenMs: number;
  lastMeta?: unknown;
}

export function quirkHit(key: string, meta?: unknown): void {
  try {
    const now = Date.now();
    HITS.set(key, (HITS.get(key) ?? 0) + 1);
    LAST_SEEN.set(key, now);
    if (!FIRST_SEEN.has(key)) FIRST_SEEN.set(key, now);
    if (meta !== undefined) LAST_META.set(key, meta);
  } catch {
    // Never let observability crash a caller.
  }
}

export function getQuirkHits(): Record<string, QuirkHitRecord> {
  const out: Record<string, QuirkHitRecord> = {};
  for (const [key, count] of HITS) {
    out[key] = {
      count,
      firstSeenMs: FIRST_SEEN.get(key) ?? 0,
      lastSeenMs: LAST_SEEN.get(key) ?? 0,
      lastMeta: LAST_META.get(key),
    };
  }
  return out;
}

export function resetQuirkHits(): void {
  HITS.clear();
  LAST_META.clear();
  FIRST_SEEN.clear();
  LAST_SEEN.clear();
}

/** Shared freshness utilities for service-brief section indicators. */

/** Age threshold in milliseconds after which data is considered stale. */
export const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface FreshnessInfo {
  text: string;
  isStale: boolean;
}

/**
 * Returns display text and stale flag for a given fetchedAt epoch-ms timestamp.
 * Returns null when fetchedAt is undefined (data has never been fetched).
 */
export function formatFreshness(fetchedAt?: number): FreshnessInfo | null {
  if (fetchedAt === undefined) return null;
  const ageMs = Date.now() - fetchedAt;
  const ageSec = Math.round(ageMs / 1000);
  const isStale = ageMs > STALE_THRESHOLD_MS;
  return { text: `Updated ${ageSec}s ago`, isStale };
}

// src/web/lib/scan-runs-query.ts
//
// Shared URL-state shape for the /activity/scans tab. Mirrors the server-side
// filter set on GET /api/scan/runs (see src/server/routes.ts for the canonical
// list). Kept client-side only — server owns its own parser, so URL tampering
// can never bypass server validation.

export type ScanStatus = "running" | "complete" | "failed" | "skipped";
export type ScanTrigger = "manual" | "cron";
export type ScanOutcome = "clean" | "tripped" | "dispatched";
export type ScanSort = "started_at" | "duration";
export type ScanDateRange = "24h" | "7d" | "30d";

export interface ScanRunsQuery {
  status?: ScanStatus[];
  trigger?: ScanTrigger[];
  outcome?: ScanOutcome[];
  /**
   * Rolling window preset. Same idea as InvestigationsQuery.range — kept as
   * a preset key so a bookmarked `?range=24h` still means "last 24 hours" an
   * hour later. Resolved to an absolute `since` timestamp at fetch time.
   */
  range?: ScanDateRange;
  since?: string;
  until?: string;
  sort?: ScanSort;
  limit?: number;
  offset?: number;
}

const VALID_STATUS: ReadonlySet<ScanStatus> = new Set(["running", "complete", "failed", "skipped"]);
const VALID_TRIGGER: ReadonlySet<ScanTrigger> = new Set(["manual", "cron"]);
const VALID_OUTCOME: ReadonlySet<ScanOutcome> = new Set(["clean", "tripped", "dispatched"]);
const VALID_SORT: ReadonlySet<ScanSort> = new Set(["started_at", "duration"]);
const VALID_RANGE: ReadonlySet<ScanDateRange> = new Set(["24h", "7d", "30d"]);

const RANGE_MS: Record<ScanDateRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve `range` to an absolute ISO `since` timestamp at fetch time. Range
 * takes precedence over an explicit `since` if both are set (UI never sets
 * both, but a hand-edited URL might).
 */
export function resolveRangeToSince(
  query: ScanRunsQuery,
  now: number = Date.now(),
): ScanRunsQuery {
  if (!query.range) return query;
  const { range, ...rest } = query;
  return { ...rest, since: new Date(now - RANGE_MS[range]).toISOString() };
}

/** Parse a comma-separated value into a typed enum array, dropping unknowns. */
function parseEnumCsv<T extends string>(raw: string | null, allowed: ReadonlySet<T>): T[] | undefined {
  if (!raw) return undefined;
  const out: T[] = [];
  for (const tok of raw.split(",")) {
    const t = tok.trim();
    if ((allowed as ReadonlySet<string>).has(t)) out.push(t as T);
  }
  return out.length ? out : undefined;
}

function parseSingleEnum<T extends string>(raw: string | null, allowed: ReadonlySet<T>): T | undefined {
  if (!raw) return undefined;
  return (allowed as ReadonlySet<string>).has(raw) ? (raw as T) : undefined;
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Parse a URL search string into ScanRunsQuery. Tolerant: unknown keys are
 * ignored, invalid enum tokens are dropped silently, malformed integers fall
 * back to undefined. Bookmarks and pasted links shouldn't be punished by
 * strict parsing.
 */
export function parseScanRunsQuery(search: string): ScanRunsQuery {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: ScanRunsQuery = {};
  const status = parseEnumCsv(params.get("status"), VALID_STATUS);
  if (status) out.status = status;
  const trigger = parseEnumCsv(params.get("trigger"), VALID_TRIGGER);
  if (trigger) out.trigger = trigger;
  const outcome = parseEnumCsv(params.get("outcome"), VALID_OUTCOME);
  if (outcome) out.outcome = outcome;
  const range = parseSingleEnum(params.get("range"), VALID_RANGE);
  if (range) out.range = range;
  const since = params.get("since"); if (since) out.since = since;
  const until = params.get("until"); if (until) out.until = until;
  const sort = parseSingleEnum(params.get("sort"), VALID_SORT);
  if (sort) out.sort = sort;
  const limit = parsePositiveInt(params.get("limit"));
  if (limit !== undefined) out.limit = limit;
  const offset = parsePositiveInt(params.get("offset"));
  if (offset !== undefined && offset > 0) out.offset = offset;
  return out;
}

/**
 * Serialize ScanRunsQuery back to a URL query string (no leading `?`). Empty
 * arrays and zero-offset are omitted so the URL stays clean. Output is stable
 * (same input → same string) so React keys and history dedup behave well.
 */
export function stringifyScanRunsQuery(query: ScanRunsQuery): string {
  const params = new URLSearchParams();
  if (query.status?.length) params.set("status", query.status.join(","));
  if (query.trigger?.length) params.set("trigger", query.trigger.join(","));
  if (query.outcome?.length) params.set("outcome", query.outcome.join(","));
  if (query.range) params.set("range", query.range);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.sort) params.set("sort", query.sort);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined && query.offset > 0) params.set("offset", String(query.offset));
  return params.toString();
}

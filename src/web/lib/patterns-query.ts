// src/web/lib/patterns-query.ts
//
// Shared URL-state shape for the /activity/patterns tab. Mirrors the server-side
// filter set on GET /api/patterns. Kept client-side only — server owns its own
// parser, so URL tampering can never bypass server validation.

export type PatternSeverity = "low" | "medium" | "high" | "critical";
export type PatternSort = "created_at" | "severity";
export type PatternDateRange = "24h" | "7d" | "30d";

export interface PatternsQuery {
  service?: string;
  severity?: PatternSeverity[];
  /**
   * Rolling window preset. Same idea as the other URL-state schemas — kept as
   * a preset key so a bookmarked `?range=24h` still means "last 24 hours" an
   * hour later. Resolved to an absolute `since` timestamp at fetch time.
   */
  range?: PatternDateRange;
  since?: string;
  until?: string;
  q?: string;
  sort?: PatternSort;
  limit?: number;
  offset?: number;
}

const VALID_SEVERITY: ReadonlySet<PatternSeverity> = new Set(["low", "medium", "high", "critical"]);
const VALID_SORT: ReadonlySet<PatternSort> = new Set(["created_at", "severity"]);
const VALID_RANGE: ReadonlySet<PatternDateRange> = new Set(["24h", "7d", "30d"]);

const RANGE_MS: Record<PatternDateRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve `range` to an absolute ISO `since` timestamp at fetch time. Range
 * takes precedence over an explicit `since` if both are set.
 */
export function resolveRangeToSince(query: PatternsQuery, now: number = Date.now()): PatternsQuery {
  if (!query.range) return query;
  const { range, ...rest } = query;
  return { ...rest, since: new Date(now - RANGE_MS[range]).toISOString() };
}

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

/** Parse a URL search string into PatternsQuery. Tolerant of unknown keys. */
export function parsePatternsQuery(search: string): PatternsQuery {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: PatternsQuery = {};
  const service = params.get("service"); if (service) out.service = service;
  const severity = parseEnumCsv(params.get("severity"), VALID_SEVERITY);
  if (severity) out.severity = severity;
  const range = parseSingleEnum(params.get("range"), VALID_RANGE);
  if (range) out.range = range;
  const since = params.get("since"); if (since) out.since = since;
  const until = params.get("until"); if (until) out.until = until;
  const q = params.get("q"); if (q) out.q = q;
  const sort = parseSingleEnum(params.get("sort"), VALID_SORT);
  if (sort) out.sort = sort;
  const limit = parsePositiveInt(params.get("limit"));
  if (limit !== undefined) out.limit = limit;
  const offset = parsePositiveInt(params.get("offset"));
  if (offset !== undefined && offset > 0) out.offset = offset;
  return out;
}

/** Serialize PatternsQuery back to a URL query string (no leading `?`). */
export function stringifyPatternsQuery(query: PatternsQuery): string {
  const params = new URLSearchParams();
  if (query.service) params.set("service", query.service);
  if (query.severity?.length) params.set("severity", query.severity.join(","));
  if (query.range) params.set("range", query.range);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.q) params.set("q", query.q);
  if (query.sort) params.set("sort", query.sort);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined && query.offset > 0) params.set("offset", String(query.offset));
  return params.toString();
}

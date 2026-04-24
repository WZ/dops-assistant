// src/web/lib/investigations-query.ts
//
// Shared URL-state shape for the /investigations list page. Mirrors the
// server-side InvestigationFilters so `parseInvestigationsQuery(search)` gives
// you something you can pass straight to fetch as a query string and the
// server will understand. Kept client-side only — server owns its own parser
// (src/server/investigation-filters.ts) so the two sides can evolve without
// a shared package, and so URL tampering never bypasses server validation.

export type Severity = "critical" | "high" | "medium" | "low";
export type Status = "running" | "complete" | "failed";
export type Sort = "created_at" | "confidence";
export type DateRange = "24h" | "7d" | "30d";

export interface InvestigationsQuery {
  severity?: Severity[];
  status?: Status[];
  service?: string;
  /**
   * Rolling window preset. Client-only URL key: resolved to an absolute `since`
   * timestamp at fetch time via `resolveRangeToSince`. Keeping the preset key
   * in the URL (instead of a computed timestamp) makes presets round-trip: a
   * bookmarked `?range=7d` still means "last 7 days" an hour later, and the
   * corresponding pill stays highlighted without drift.
   */
  range?: DateRange;
  since?: string;
  until?: string;
  q?: string;
  sort?: Sort;
  limit?: number;
  offset?: number;
}

const VALID_SEVERITY: ReadonlySet<Severity> = new Set(["critical", "high", "medium", "low"]);
const VALID_STATUS: ReadonlySet<Status> = new Set(["running", "complete", "failed"]);
const VALID_SORT: ReadonlySet<Sort> = new Set(["created_at", "confidence"]);
const VALID_RANGE: ReadonlySet<DateRange> = new Set(["24h", "7d", "30d"]);

const RANGE_MS: Record<DateRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve `range` to an absolute ISO `since` timestamp at fetch time. `range`
 * takes precedence over an explicit `since` so the preset wins if both were
 * somehow set at once (never happens via the UI, but a hand-edited URL might).
 * The returned object is safe to pass to `stringifyInvestigationsQuery` for
 * the server — `range` is stripped, `since` is set.
 */
export function resolveRangeToSince(
  query: InvestigationsQuery,
  now: number = Date.now(),
): InvestigationsQuery {
  if (!query.range) return query;
  const { range, ...rest } = query;
  return { ...rest, since: new Date(now - RANGE_MS[range]).toISOString() };
}

/**
 * Matches the server's HTTP cap in src/server/investigation-filters.ts.
 * Without this ceiling, a URL like `?limit=1000` renders only the 100 rows
 * the server actually returns but tells the paginator the page is 1000 wide,
 * so Next jumps offset by 1000 and silently skips 900 investigations.
 */
const MAX_LIMIT = 100;

/**
 * Accept only formats SQLite's datetime() function can parse. Mirrors the
 * server-side regex in src/server/investigation-filters.ts. Without this the
 * client would happily pass strings like "yesterday" through to the API,
 * which would 400; a bookmarked / hand-edited URL then lands the user on an
 * error screen instead of falling back to the unfiltered list.
 */
const SQLITE_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isValidTimestamp(s: string): boolean {
  return SQLITE_DATETIME_RE.test(s) && Number.isFinite(Date.parse(s));
}

function parseCsv<T extends string>(raw: string | null, allowed: ReadonlySet<T>): T[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const filtered = parts.filter((p): p is T => allowed.has(p as T));
  return filtered.length > 0 ? filtered : undefined;
}

function parseIntBounded(raw: string | null, min: number): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return undefined;
  return Math.floor(n);
}

/**
 * Parse a URL search string (with or without leading `?`) into a query object.
 * Unknown keys are ignored and invalid values are dropped silently — URL state
 * is soft input (bookmarks, copy/paste, hand-edited), so the page still loads
 * with a reasonable filter set even when the string is partly garbage. The
 * server-side parser is the authoritative validator.
 */
export function parseInvestigationsQuery(search: string): InvestigationsQuery {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const q: InvestigationsQuery = {};

  const sev = parseCsv(params.get("severity"), VALID_SEVERITY);
  if (sev) q.severity = sev;

  const st = parseCsv(params.get("status"), VALID_STATUS);
  if (st) q.status = st;

  const service = params.get("service");
  if (service) q.service = service;

  const range = params.get("range");
  if (range && VALID_RANGE.has(range as DateRange)) q.range = range as DateRange;

  // If range is set it wins, since/until are ignored to avoid contradictory
  // URLs like `?range=7d&since=1999-01-01`. A plain `?since=…` without range
  // still loads — that's the "custom window" path.
  if (!q.range) {
    const since = params.get("since");
    if (since && isValidTimestamp(since)) q.since = since;

    const until = params.get("until");
    if (until && isValidTimestamp(until)) q.until = until;
  }

  const text = params.get("q");
  if (text) q.q = text;

  const sort = params.get("sort");
  if (sort && VALID_SORT.has(sort as Sort)) q.sort = sort as Sort;

  const limit = parseIntBounded(params.get("limit"), 1);
  if (limit !== undefined) q.limit = Math.min(limit, MAX_LIMIT);

  const offset = parseIntBounded(params.get("offset"), 0);
  if (offset !== undefined) q.offset = offset;

  return q;
}

/**
 * Serialize a query object back into a search string (without leading `?`).
 * Round-trips with parseInvestigationsQuery for any valid input. Keys are
 * emitted in a stable order so identical queries produce identical URLs,
 * which keeps the browser back/forward stack clean.
 */
export function stringifyInvestigationsQuery(query: InvestigationsQuery): string {
  const params = new URLSearchParams();
  if (query.severity && query.severity.length > 0) params.set("severity", query.severity.join(","));
  if (query.status && query.status.length > 0) params.set("status", query.status.join(","));
  if (query.service) params.set("service", query.service);
  if (query.range) params.set("range", query.range);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.q) params.set("q", query.q);
  if (query.sort) params.set("sort", query.sort);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  return params.toString();
}

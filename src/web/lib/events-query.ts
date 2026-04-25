// src/web/lib/events-query.ts
//
// URL-state shape for the /activity/events tab. Mirrors the server-side
// filter set on GET /api/events. Kept client-side only — server owns its
// own parser, so URL tampering can never bypass server validation.

export type EventSeverity = "info" | "warn" | "error" | "success";
export type EventDateRange = "1h" | "24h" | "7d" | "30d";

/** Open enum for event kinds — see src/types/events.ts EventKind. We keep
 *  the URL parser loose (any non-empty token) so new kinds added server-side
 *  don't require a coordinated client release. The dropdown options come
 *  from the server's `kinds` field, not a hardcoded list. */
export interface EventsQuery {
  kind?: string[];
  severity?: EventSeverity[];
  service?: string;
  /**
   * Rolling window preset. Same idea as the other tabs — kept as a preset
   * key so a bookmarked `?range=24h` still means "last 24 hours" later.
   * Resolved to absolute `since` at fetch time.
   */
  range?: EventDateRange;
  since?: string;
  until?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

const VALID_SEVERITY: ReadonlySet<EventSeverity> = new Set(["info", "warn", "error", "success"]);
const VALID_RANGE: ReadonlySet<EventDateRange> = new Set(["1h", "24h", "7d", "30d"]);

const RANGE_MS: Record<EventDateRange, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve `range` to an absolute ISO `since` timestamp at fetch time. Range
 * takes precedence over an explicit `since` if both are set.
 */
export function resolveRangeToSince(query: EventsQuery, now: number = Date.now()): EventsQuery {
  if (!query.range) return query;
  const { range, ...rest } = query;
  return { ...rest, since: new Date(now - RANGE_MS[range]).toISOString() };
}

function parseTypedEnumCsv<T extends string>(raw: string | null, allowed: ReadonlySet<T>): T[] | undefined {
  if (!raw) return undefined;
  const out: T[] = [];
  for (const tok of raw.split(",")) {
    const t = tok.trim();
    if ((allowed as ReadonlySet<string>).has(t)) out.push(t as T);
  }
  return out.length ? out : undefined;
}

function parseLooseCsv(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const out: string[] = [];
  for (const tok of raw.split(",")) {
    const t = tok.trim();
    if (t) out.push(t);
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

/** Parse a URL search string into EventsQuery. Tolerant of unknown keys. */
export function parseEventsQuery(search: string): EventsQuery {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: EventsQuery = {};
  const kind = parseLooseCsv(params.get("kind"));
  if (kind) out.kind = kind;
  const severity = parseTypedEnumCsv(params.get("severity"), VALID_SEVERITY);
  if (severity) out.severity = severity;
  const service = params.get("service"); if (service) out.service = service;
  const range = parseSingleEnum(params.get("range"), VALID_RANGE);
  if (range) out.range = range;
  const since = params.get("since"); if (since) out.since = since;
  const until = params.get("until"); if (until) out.until = until;
  const q = params.get("q"); if (q) out.q = q;
  const limit = parsePositiveInt(params.get("limit"));
  if (limit !== undefined) out.limit = limit;
  const offset = parsePositiveInt(params.get("offset"));
  if (offset !== undefined && offset > 0) out.offset = offset;
  return out;
}

/** Serialize EventsQuery back to a URL query string (no leading `?`). */
export function stringifyEventsQuery(query: EventsQuery): string {
  const params = new URLSearchParams();
  if (query.kind?.length) params.set("kind", query.kind.join(","));
  if (query.severity?.length) params.set("severity", query.severity.join(","));
  if (query.service) params.set("service", query.service);
  if (query.range) params.set("range", query.range);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.q) params.set("q", query.q);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined && query.offset > 0) params.set("offset", String(query.offset));
  return params.toString();
}

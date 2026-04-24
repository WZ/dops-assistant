// src/server/investigation-filters.ts
//
// Parse + validate the query string of GET /api/investigations into an
// InvestigationFilters object ready for listInvestigations/countInvestigations.
// Isolated from routes.ts so it can be tested without spinning up Express.

import type { InvestigationFilters, Severity } from "./db.js";

const VALID_SEVERITY: ReadonlySet<Severity> = new Set(["critical", "high", "medium", "low"]);
const VALID_STATUS: ReadonlySet<string> = new Set(["running", "complete", "failed"]);
const VALID_SORT: ReadonlySet<NonNullable<InvestigationFilters["sort"]>> = new Set(["created_at", "confidence"]);

// Length ceilings for free-text inputs. Without these a 10KB `q` forces the DB
// into a 4-column LIKE scan (service, query, json_extract(report,'$.summary'),
// json_extract(report,'$.rootCause')) on every row — a trivial CPU DoS from
// one misbehaving client on the VPN. The caps are well above any real typed
// search (UUID = 36, email ~60) and any real service name (k8s object names
// cap at 253), so legitimate inputs are never rejected.
const MAX_Q_LENGTH = 200;
const MAX_SERVICE_LENGTH = 128;

type Parsed =
  | { filters: InvestigationFilters }
  | { error: string };

/**
 * Pull a string value out of Express's Request["query"] (which can be string,
 * string[], or ParsedQs). We treat only primitive string values as valid input;
 * anything else returns undefined so downstream validation can report a clear
 * error instead of silently dropping part of the input.
 */
function getString(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function parseMulti<T extends string>(raw: string | undefined, allowed: ReadonlySet<T>): T[] | { error: string } {
  if (!raw) return [];
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (!allowed.has(p as T)) {
      return { error: `invalid value '${p}'` };
    }
  }
  return parts as T[];
}

// Accept only formats SQLite's datetime() function can actually parse:
//   - strict ISO with T:  2026-04-23T00:00:00Z  /  2026-04-23T00:00:00
//   - SQLite-style space: 2026-04-23 00:00:00
//   - date-only:          2026-04-23
// Using Date.parse() here would greenlight US-style "04/23/2026" or RFC
// "Thu Apr 23 2026 ...", both of which SQLite turns into NULL at query
// time — filtering out every row silently instead of erroring. The
// stricter regex + Date.parse sanity check rejects those upfront so a
// bad input surfaces as a 400 at the parse layer.
const SQLITE_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isValidIso(s: string): boolean {
  if (!SQLITE_DATETIME_RE.test(s)) return false;
  return Number.isFinite(Date.parse(s));
}

export function parseInvestigationFilters(query: Record<string, unknown>): Parsed {
  const filters: InvestigationFilters = {};

  const limitRaw = getString(query["limit"]);
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n < 1) return { error: "limit must be a positive integer" };
    filters.limit = Math.min(Math.floor(n), 100);
  }

  const offsetRaw = getString(query["offset"]);
  if (offsetRaw !== undefined) {
    const n = Number(offsetRaw);
    if (!Number.isFinite(n) || n < 0) return { error: "offset must be a non-negative integer" };
    filters.offset = Math.floor(n);
  }

  const service = getString(query["service"]);
  if (service) {
    if (service.length > MAX_SERVICE_LENGTH) {
      return { error: `service must be ${MAX_SERVICE_LENGTH} characters or fewer` };
    }
    filters.service = service;
  }

  const sev = parseMulti(getString(query["severity"]), VALID_SEVERITY);
  if ("error" in sev) return { error: `severity: ${sev.error}` };
  if (sev.length > 0) filters.severity = sev;

  const status = parseMulti(getString(query["status"]), VALID_STATUS);
  if ("error" in status) return { error: `status: ${status.error}` };
  if (status.length > 0) filters.status = status;

  const since = getString(query["since"]);
  if (since) {
    if (!isValidIso(since)) return { error: "since must be a valid ISO 8601 timestamp" };
    filters.since = since;
  }

  const until = getString(query["until"]);
  if (until) {
    if (!isValidIso(until)) return { error: "until must be a valid ISO 8601 timestamp" };
    filters.until = until;
  }

  // Reject contradictory windows at the boundary rather than silently returning
  // zero rows. A hand-edited URL with since=2026-04-23&until=2026-04-22 is a
  // typo, not a query — 400 surfaces the mistake where 200 with empty results
  // would hide it.
  if (filters.since && filters.until && Date.parse(filters.since) > Date.parse(filters.until)) {
    return { error: "since must be earlier than or equal to until" };
  }

  const q = getString(query["q"]);
  if (q) {
    if (q.length > MAX_Q_LENGTH) {
      return { error: `q must be ${MAX_Q_LENGTH} characters or fewer` };
    }
    filters.q = q;
  }

  const sort = getString(query["sort"]);
  if (sort !== undefined) {
    if (!VALID_SORT.has(sort as NonNullable<InvestigationFilters["sort"]>)) {
      return { error: `sort must be one of: ${[...VALID_SORT].join(", ")}` };
    }
    filters.sort = sort as NonNullable<InvestigationFilters["sort"]>;
  }

  return { filters };
}

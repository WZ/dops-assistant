// src/server/investigation-filters.ts
//
// Parse + validate the query string of GET /api/investigations into an
// InvestigationFilters object ready for listInvestigations/countInvestigations.
// Isolated from routes.ts so it can be tested without spinning up Express.

import type { InvestigationFilters, Severity } from "./db.js";

const VALID_SEVERITY: ReadonlySet<Severity> = new Set(["critical", "high", "medium", "low"]);
const VALID_STATUS: ReadonlySet<string> = new Set(["running", "complete", "failed"]);
const VALID_SORT: ReadonlySet<NonNullable<InvestigationFilters["sort"]>> = new Set(["created_at", "confidence"]);

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

function isValidIso(s: string): boolean {
  // Accept either strict ISO (with T) or SQLite-style datetime with a space.
  // Both parse correctly when wrapped in SQLite's datetime() function at
  // query time; rejecting known-garbage shapes here prevents surprises.
  const t = Date.parse(s);
  return Number.isFinite(t);
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
  if (service) filters.service = service;

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

  const q = getString(query["q"]);
  if (q) filters.q = q;

  const sort = getString(query["sort"]);
  if (sort !== undefined) {
    if (!VALID_SORT.has(sort as NonNullable<InvestigationFilters["sort"]>)) {
      return { error: `sort must be one of: ${[...VALID_SORT].join(", ")}` };
    }
    filters.sort = sort as NonNullable<InvestigationFilters["sort"]>;
  }

  return { filters };
}

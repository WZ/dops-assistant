import { describe, it, expect } from "vitest";
import { parseInvestigationFilters } from "./investigation-filters.js";

// Helper: assert the parse succeeded and narrow to the filter object.
function ok(result: ReturnType<typeof parseInvestigationFilters>) {
  if ("error" in result) throw new Error(`expected success, got error: ${result.error}`);
  return result.filters;
}

describe("parseInvestigationFilters", () => {
  it("empty query yields empty filters", () => {
    expect(ok(parseInvestigationFilters({}))).toEqual({});
  });

  it("parses limit + offset as numbers with caps", () => {
    expect(ok(parseInvestigationFilters({ limit: "25", offset: "50" }))).toMatchObject({ limit: 25, offset: 50 });
    // Upper cap at 100 for HTTP safety — 500 should become 100.
    expect(ok(parseInvestigationFilters({ limit: "500" })).limit).toBe(100);
    // Floor at 1 handled implicitly — 0 triggers validation error
    expect("error" in parseInvestigationFilters({ limit: "0" })).toBe(true);
    expect("error" in parseInvestigationFilters({ limit: "-1" })).toBe(true);
    expect("error" in parseInvestigationFilters({ offset: "-1" })).toBe(true);
    expect("error" in parseInvestigationFilters({ limit: "not-a-number" })).toBe(true);
  });

  it("passes service through verbatim (exact match downstream)", () => {
    expect(ok(parseInvestigationFilters({ service: "admin-task" })).service).toBe("admin-task");
  });

  it("parses comma-delimited severity and validates each value", () => {
    expect(ok(parseInvestigationFilters({ severity: "critical" })).severity).toEqual(["critical"]);
    expect(ok(parseInvestigationFilters({ severity: "critical,high" })).severity).toEqual(["critical", "high"]);
    // Whitespace tolerated around values
    expect(ok(parseInvestigationFilters({ severity: " critical , high " })).severity).toEqual(["critical", "high"]);
    // Empty string = no filter (not an error)
    expect(ok(parseInvestigationFilters({ severity: "" })).severity).toBeUndefined();
    // Unknown value = 400
    const err = parseInvestigationFilters({ severity: "critical,bogus" });
    expect("error" in err && err.error).toMatch(/severity/);
  });

  it("parses status similarly with its own enum", () => {
    expect(ok(parseInvestigationFilters({ status: "running,complete" })).status).toEqual(["running", "complete"]);
    const err = parseInvestigationFilters({ status: "pending" });
    expect("error" in err && err.error).toMatch(/status/);
  });

  it("accepts ISO timestamps and strict SQLite datetime strings, rejects garbage", () => {
    expect(ok(parseInvestigationFilters({ since: "2026-04-23T00:00:00Z" })).since).toBe("2026-04-23T00:00:00Z");
    expect(ok(parseInvestigationFilters({ until: "2026-04-23 00:00:00" })).until).toBe("2026-04-23 00:00:00");
    expect(ok(parseInvestigationFilters({ since: "2026-04-23" })).since).toBe("2026-04-23"); // date-only
    expect("error" in parseInvestigationFilters({ since: "yesterday" })).toBe(true);
    expect("error" in parseInvestigationFilters({ until: "" })).toBe(false); // empty = absent
    // Date.parse() accepts these but SQLite datetime() returns NULL — silently
    // filters out every row. Must reject at the parse layer or users get
    // mystery empty results instead of a clear 400.
    expect("error" in parseInvestigationFilters({ since: "04/23/2026" })).toBe(true);
    expect("error" in parseInvestigationFilters({ until: "Thu Apr 23 2026" })).toBe(true);
  });

  it("passes q (search string) through verbatim; LIKE escaping happens in SQL layer", () => {
    expect(ok(parseInvestigationFilters({ q: "redis" })).q).toBe("redis");
    // The parser doesn't escape — that's the DB layer's job. Any user input accepted here.
    expect(ok(parseInvestigationFilters({ q: "%_foo" })).q).toBe("%_foo");
    // Empty string treated as no filter.
    expect(ok(parseInvestigationFilters({ q: "" })).q).toBeUndefined();
  });

  it("validates sort against enum", () => {
    expect(ok(parseInvestigationFilters({ sort: "created_at" })).sort).toBe("created_at");
    expect(ok(parseInvestigationFilters({ sort: "confidence" })).sort).toBe("confidence");
    expect("error" in parseInvestigationFilters({ sort: "severity" })).toBe(true);
  });

  it("ignores non-string query values (e.g. arrays from duplicate params)", () => {
    // Express's req.query can give arrays for ?foo=a&foo=b — we treat these as absent
    // to avoid silently using only the first value. Shape stays strict.
    expect(ok(parseInvestigationFilters({ severity: ["critical", "high"] as unknown as string })).severity).toBeUndefined();
  });
});

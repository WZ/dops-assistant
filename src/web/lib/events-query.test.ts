import { describe, it, expect } from "vitest";
import {
  parseEventsQuery,
  stringifyEventsQuery,
  resolveRangeToSince,
  type EventsQuery,
} from "./events-query";

describe("parseEventsQuery", () => {
  it("parses an empty search to {}", () => {
    expect(parseEventsQuery("")).toEqual({});
    expect(parseEventsQuery("?")).toEqual({});
  });

  it("parses kind / severity / service / range / q", () => {
    expect(
      parseEventsQuery("?kind=investigation_started,scan_run_complete&severity=error,warn&service=payments-api&range=24h&q=oom"),
    ).toEqual({
      kind: ["investigation_started", "scan_run_complete"],
      severity: ["error", "warn"],
      service: "payments-api",
      range: "24h",
      q: "oom",
    });
  });

  it("kind parser is loose — accepts any non-empty token", () => {
    // EventKind is open-ended server-side; new kinds shouldn't require a
    // client release.
    expect(parseEventsQuery("?kind=brand_new_kind")).toEqual({ kind: ["brand_new_kind"] });
  });

  it("kind parser drops empty tokens after split/trim", () => {
    expect(parseEventsQuery("?kind=,foo,, ,bar,")).toEqual({ kind: ["foo", "bar"] });
  });

  it("severity parser is strict — drops unknown values", () => {
    expect(parseEventsQuery("?severity=info,bogus,error")).toEqual({ severity: ["info", "error"] });
    expect(parseEventsQuery("?severity=onlybad")).toEqual({});
  });

  it("ignores invalid range values", () => {
    expect(parseEventsQuery("?range=99d")).toEqual({});
  });

  it("includes 1h as a valid range (events page has shorter windows than other tabs)", () => {
    expect(parseEventsQuery("?range=1h")).toEqual({ range: "1h" });
  });

  it("ignores zero offset", () => {
    expect(parseEventsQuery("?offset=0")).toEqual({});
  });
});

describe("stringifyEventsQuery", () => {
  it("returns empty string for {}", () => {
    expect(stringifyEventsQuery({})).toBe("");
  });

  it("encodes a populated query", () => {
    const out = stringifyEventsQuery({
      kind: ["investigation_started"],
      severity: ["error"],
      service: "payments-api",
      range: "24h",
      q: "oom",
      limit: 50,
      offset: 25,
    });
    expect(out).toContain("kind=investigation_started");
    expect(out).toContain("severity=error");
    expect(out).toContain("service=payments-api");
    expect(out).toContain("range=24h");
    expect(out).toContain("q=oom");
    expect(out).toContain("limit=50");
    expect(out).toContain("offset=25");
  });

  it("omits empty arrays and zero offset", () => {
    expect(stringifyEventsQuery({ kind: [], severity: [], offset: 0 })).toBe("");
  });
});

describe("roundtrip", () => {
  it("parseEventsQuery(stringifyEventsQuery(q)) === q", () => {
    const queries: EventsQuery[] = [
      {},
      { kind: ["investigation_started"] },
      { severity: ["error", "warn"] },
      { range: "1h", q: "timeout" },
      { service: "checkout", limit: 100, offset: 50 },
      { since: "2026-04-01T00:00:00Z", until: "2026-04-25T00:00:00Z" },
    ];
    for (const q of queries) {
      expect(parseEventsQuery("?" + stringifyEventsQuery(q))).toEqual(q);
    }
  });
});

describe("resolveRangeToSince", () => {
  it("strips range and sets since when range is set", () => {
    const now = new Date("2026-04-25T12:00:00Z").getTime();
    const out = resolveRangeToSince({ range: "1h" }, now);
    expect(out.range).toBeUndefined();
    expect(out.since).toBe(new Date(now - 60 * 60 * 1000).toISOString());
  });

  it("is a no-op when range is unset", () => {
    expect(resolveRangeToSince({ q: "x" })).toEqual({ q: "x" });
  });

  it("range takes precedence over an explicit since", () => {
    const now = new Date("2026-04-25T12:00:00Z").getTime();
    const out = resolveRangeToSince({ range: "24h", since: "1990-01-01T00:00:00Z" }, now);
    expect(out.since).toBe(new Date(now - 24 * 60 * 60 * 1000).toISOString());
  });
});

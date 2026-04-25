import { describe, it, expect } from "vitest";
import {
  parsePatternsQuery,
  stringifyPatternsQuery,
  resolveRangeToSince,
  type PatternsQuery,
} from "./patterns-query";

describe("parsePatternsQuery", () => {
  it("parses an empty search to {}", () => {
    expect(parsePatternsQuery("")).toEqual({});
    expect(parsePatternsQuery("?")).toEqual({});
  });

  it("parses service / severity / q / sort / range", () => {
    expect(
      parsePatternsQuery("?service=payments-api&severity=critical,high&q=oom&sort=severity&range=7d"),
    ).toEqual({
      service: "payments-api",
      severity: ["critical", "high"],
      q: "oom",
      sort: "severity",
      range: "7d",
    });
  });

  it("drops unknown severity tokens", () => {
    expect(parsePatternsQuery("?severity=bogus,critical")).toEqual({ severity: ["critical"] });
    expect(parsePatternsQuery("?severity=onlybad")).toEqual({});
  });

  it("ignores invalid sort / range values", () => {
    expect(parsePatternsQuery("?sort=junk&range=99d")).toEqual({});
  });

  it("ignores zero offset (clean URL on page 1)", () => {
    expect(parsePatternsQuery("?offset=0")).toEqual({});
  });

  it("parses limit and non-zero offset", () => {
    expect(parsePatternsQuery("?limit=50&offset=25")).toEqual({ limit: 50, offset: 25 });
  });
});

describe("stringifyPatternsQuery", () => {
  it("returns empty string for {}", () => {
    expect(stringifyPatternsQuery({})).toBe("");
  });

  it("encodes a populated query", () => {
    const out = stringifyPatternsQuery({
      service: "payments-api",
      severity: ["high", "critical"],
      range: "24h",
      q: "oom",
      sort: "severity",
      limit: 50,
      offset: 25,
    });
    expect(out).toContain("service=payments-api");
    expect(out).toContain("severity=high%2Ccritical");
    expect(out).toContain("range=24h");
    expect(out).toContain("q=oom");
    expect(out).toContain("sort=severity");
    expect(out).toContain("limit=50");
    expect(out).toContain("offset=25");
  });

  it("omits empty arrays and zero offset", () => {
    expect(stringifyPatternsQuery({ severity: [], offset: 0 })).toBe("");
  });
});

describe("roundtrip", () => {
  it("parsePatternsQuery(stringifyPatternsQuery(q)) === q", () => {
    const queries: PatternsQuery[] = [
      {},
      { service: "checkout" },
      { severity: ["high", "critical"] },
      { range: "30d", q: "timeout", sort: "severity" },
      { limit: 10, offset: 30 },
      { since: "2026-04-01T00:00:00Z", until: "2026-04-25T00:00:00Z" },
    ];
    for (const q of queries) {
      expect(parsePatternsQuery("?" + stringifyPatternsQuery(q))).toEqual(q);
    }
  });
});

describe("resolveRangeToSince", () => {
  it("strips range and sets since when range is set", () => {
    const now = new Date("2026-04-25T12:00:00Z").getTime();
    const out = resolveRangeToSince({ range: "24h" }, now);
    expect(out.range).toBeUndefined();
    expect(out.since).toBe(new Date(now - 24 * 60 * 60 * 1000).toISOString());
  });

  it("is a no-op when range is unset", () => {
    expect(resolveRangeToSince({ service: "a" })).toEqual({ service: "a" });
  });

  it("range takes precedence over an explicit since", () => {
    const now = new Date("2026-04-25T12:00:00Z").getTime();
    const out = resolveRangeToSince({ range: "7d", since: "1990-01-01T00:00:00Z" }, now);
    expect(out.since).toBe(new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString());
  });
});

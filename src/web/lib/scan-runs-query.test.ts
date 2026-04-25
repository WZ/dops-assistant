import { describe, it, expect } from "vitest";
import {
  parseScanRunsQuery,
  stringifyScanRunsQuery,
  resolveRangeToSince,
  type ScanRunsQuery,
} from "./scan-runs-query";

describe("parseScanRunsQuery", () => {
  it("parses an empty search to {}", () => {
    expect(parseScanRunsQuery("")).toEqual({});
    expect(parseScanRunsQuery("?")).toEqual({});
  });

  it("parses status, trigger, outcome as CSV multi-select", () => {
    const q = parseScanRunsQuery("?status=running,complete&trigger=cron&outcome=tripped,dispatched");
    expect(q).toEqual({
      status: ["running", "complete"],
      trigger: ["cron"],
      outcome: ["tripped", "dispatched"],
    });
  });

  it("drops unknown enum tokens silently", () => {
    expect(parseScanRunsQuery("?status=bogus,running")).toEqual({ status: ["running"] });
    expect(parseScanRunsQuery("?status=onlybad")).toEqual({});
  });

  it("parses range / since / until / sort / limit / offset", () => {
    const q = parseScanRunsQuery("?range=24h&since=2026-04-25T00:00:00Z&until=2026-04-25T12:00:00Z&sort=duration&limit=25&offset=50");
    expect(q).toEqual({
      range: "24h",
      since: "2026-04-25T00:00:00Z",
      until: "2026-04-25T12:00:00Z",
      sort: "duration",
      limit: 25,
      offset: 50,
    });
  });

  it("ignores zero offset (clean URL on page 1)", () => {
    expect(parseScanRunsQuery("?offset=0")).toEqual({});
  });

  it("ignores invalid sort / range values", () => {
    expect(parseScanRunsQuery("?sort=bogus&range=99d")).toEqual({});
  });
});

describe("stringifyScanRunsQuery", () => {
  it("returns empty string for {}", () => {
    expect(stringifyScanRunsQuery({})).toBe("");
  });

  it("omits empty arrays and zero offset", () => {
    expect(stringifyScanRunsQuery({ status: [], offset: 0 })).toBe("");
  });

  it("encodes a populated query", () => {
    const out = stringifyScanRunsQuery({
      status: ["running", "complete"],
      trigger: ["cron"],
      outcome: ["dispatched"],
      range: "7d",
      sort: "duration",
      limit: 50,
      offset: 25,
    });
    expect(out).toContain("status=running%2Ccomplete");
    expect(out).toContain("trigger=cron");
    expect(out).toContain("outcome=dispatched");
    expect(out).toContain("range=7d");
    expect(out).toContain("sort=duration");
    expect(out).toContain("limit=50");
    expect(out).toContain("offset=25");
  });
});

describe("roundtrip", () => {
  it("parseScanRunsQuery(stringifyScanRunsQuery(q)) === q", () => {
    const queries: ScanRunsQuery[] = [
      {},
      { status: ["running"] },
      { trigger: ["manual", "cron"], outcome: ["dispatched"] },
      { range: "24h" },
      { sort: "duration", limit: 10, offset: 30 },
      { since: "2026-04-01T00:00:00Z", until: "2026-04-25T00:00:00Z" },
    ];
    for (const q of queries) {
      expect(parseScanRunsQuery("?" + stringifyScanRunsQuery(q))).toEqual(q);
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
    expect(resolveRangeToSince({ status: ["running"] })).toEqual({ status: ["running"] });
  });

  it("range takes precedence over an explicit since", () => {
    const now = new Date("2026-04-25T12:00:00Z").getTime();
    const out = resolveRangeToSince({ range: "7d", since: "1990-01-01T00:00:00Z" }, now);
    expect(out.since).toBe(new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString());
  });
});

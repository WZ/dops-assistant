import { describe, it, expect } from "vitest";
import {
  parseInvestigationsQuery,
  stringifyInvestigationsQuery,
} from "./investigations-query";

describe("parseInvestigationsQuery", () => {
  it("empty string yields empty query", () => {
    expect(parseInvestigationsQuery("")).toEqual({});
    expect(parseInvestigationsQuery("?")).toEqual({});
  });

  it("accepts both leading ? and bare query strings", () => {
    expect(parseInvestigationsQuery("?severity=critical")).toEqual({ severity: ["critical"] });
    expect(parseInvestigationsQuery("severity=critical")).toEqual({ severity: ["critical"] });
  });

  it("CSV-parses severity and filters out invalid members", () => {
    expect(parseInvestigationsQuery("?severity=critical,high,bogus")).toEqual({
      severity: ["critical", "high"],
    });
    // All invalid -> omit the key entirely (no empty array leaking through).
    expect(parseInvestigationsQuery("?severity=bogus,nope")).toEqual({});
  });

  it("parses status with the same CSV rules", () => {
    expect(parseInvestigationsQuery("?status=running,complete")).toEqual({
      status: ["running", "complete"],
    });
    expect(parseInvestigationsQuery("?status=pending")).toEqual({});
  });

  it("passes service/since/until/q through verbatim", () => {
    expect(
      parseInvestigationsQuery(
        "?service=payments-api&since=2026-04-01T00:00:00Z&until=2026-04-23&q=redis",
      ),
    ).toEqual({
      service: "payments-api",
      since: "2026-04-01T00:00:00Z",
      until: "2026-04-23",
      q: "redis",
    });
  });

  it("validates sort against the enum", () => {
    expect(parseInvestigationsQuery("?sort=created_at")).toEqual({ sort: "created_at" });
    expect(parseInvestigationsQuery("?sort=confidence")).toEqual({ sort: "confidence" });
    expect(parseInvestigationsQuery("?sort=severity")).toEqual({});
  });

  it("parses limit/offset as non-negative integers, drops garbage", () => {
    expect(parseInvestigationsQuery("?limit=50&offset=100")).toEqual({ limit: 50, offset: 100 });
    expect(parseInvestigationsQuery("?limit=0")).toEqual({}); // limit floor is 1
    expect(parseInvestigationsQuery("?offset=-5")).toEqual({});
    expect(parseInvestigationsQuery("?limit=not-a-number")).toEqual({});
  });

  it("clamps limit to the server's HTTP cap (100)", () => {
    // Server caps page size at 100. A raw URL limit > 100 would otherwise
    // render 100 rows but advance the paginator by the full limit, skipping
    // rows between pages.
    expect(parseInvestigationsQuery("?limit=500")).toEqual({ limit: 100 });
    expect(parseInvestigationsQuery("?limit=1000")).toEqual({ limit: 100 });
    // Under the cap passes through verbatim.
    expect(parseInvestigationsQuery("?limit=50")).toEqual({ limit: 50 });
    expect(parseInvestigationsQuery("?limit=100")).toEqual({ limit: 100 });
  });

  it("drops since/until values the server won't accept so bookmarks stay loadable", () => {
    // Server rejects anything Date.parse likes but SQLite datetime() can't
    // parse (04/23/2026, "yesterday", RFC dates, etc.). Without this guard
    // the parser hands the raw string to fetch and the page lands on a 400
    // banner instead of the unfiltered list.
    expect(parseInvestigationsQuery("?since=yesterday")).toEqual({});
    expect(parseInvestigationsQuery("?since=04/23/2026")).toEqual({});
    expect(parseInvestigationsQuery("?until=Thu Apr 23 2026")).toEqual({});
    // Valid formats still pass.
    expect(parseInvestigationsQuery("?since=2026-04-23T00:00:00Z")).toEqual({
      since: "2026-04-23T00:00:00Z",
    });
    expect(parseInvestigationsQuery("?until=2026-04-23 00:00:00")).toEqual({
      until: "2026-04-23 00:00:00",
    });
    expect(parseInvestigationsQuery("?since=2026-04-23")).toEqual({ since: "2026-04-23" });
  });

  it("empty-string values behave like absent (no filter applied)", () => {
    expect(parseInvestigationsQuery("?service=&q=&severity=")).toEqual({});
  });

  it("ignores unknown keys", () => {
    expect(parseInvestigationsQuery("?severity=critical&foo=bar")).toEqual({
      severity: ["critical"],
    });
  });
});

describe("stringifyInvestigationsQuery", () => {
  it("empty query -> empty string (no stray ?)", () => {
    expect(stringifyInvestigationsQuery({})).toBe("");
  });

  it("joins multi-value filters with commas", () => {
    expect(
      stringifyInvestigationsQuery({ severity: ["critical", "high"], status: ["running"] }),
    ).toBe("severity=critical%2Chigh&status=running");
  });

  it("skips undefined / empty-array values", () => {
    expect(stringifyInvestigationsQuery({ severity: [] })).toBe("");
    expect(stringifyInvestigationsQuery({ service: "" })).toBe("");
  });

  it("serializes numbers as strings", () => {
    expect(stringifyInvestigationsQuery({ limit: 50, offset: 100 })).toBe("limit=50&offset=100");
    // offset: 0 is the default but the caller is free to pass it explicitly;
    // we still emit it so the URL round-trips verbatim.
    expect(stringifyInvestigationsQuery({ offset: 0 })).toBe("offset=0");
  });
});

describe("round-trip parse/stringify", () => {
  it("survives a representative mixed query", () => {
    const q = {
      severity: ["critical", "high"] as const,
      status: ["running"] as const,
      service: "payments-api",
      since: "2026-04-01T00:00:00Z",
      until: "2026-04-23",
      q: "redis",
      sort: "confidence" as const,
      limit: 50,
      offset: 100,
    };
    expect(parseInvestigationsQuery(stringifyInvestigationsQuery(q))).toEqual(q);
  });

  it("preserves URL-unsafe characters in q", () => {
    const q = { q: "name with spaces & %=+" };
    expect(parseInvestigationsQuery(stringifyInvestigationsQuery(q))).toEqual(q);
  });
});

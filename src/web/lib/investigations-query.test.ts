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

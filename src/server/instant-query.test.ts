import { describe, it, expect, vi } from "vitest";
import { executeInstantMetric, type InstantResult } from "./instant-query.js";

const tool = (impl: (args: unknown) => unknown) => ({
  execute: vi.fn(async (args, _opts) => impl(args)),
});

describe("executeInstantMetric", () => {
  it("returns kind:'ok' on a numeric instant-vector sample", async () => {
    const t = tool(() => ({
      data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "1"] }] },
    }));
    const r: InstantResult = await executeInstantMetric(t, "up{}", "ds-1", undefined, 5000);
    expect(r).toEqual({ kind: "ok", value: 1 });
  });

  it("returns kind:'empty' on an empty result vector", async () => {
    const t = tool(() => ({ data: { resultType: "vector", result: [] } }));
    const r = await executeInstantMetric(t, "up{}", "ds-1", undefined, 5000);
    expect(r.kind).toBe("empty");
    expect(Number.isNaN(r.value)).toBe(true);
  });

  it("returns kind:'ok' for multi-series (uses the first sample)", async () => {
    const t = tool(() => ({
      data: { resultType: "vector", result: [
        { metric: { pod: "a" }, value: [1700000000, "1"] },
        { metric: { pod: "b" }, value: [1700000000, "1"] },
      ] },
    }));
    const r = await executeInstantMetric(t, "up{service=\"foo\"}", "ds-1", undefined, 5000);
    expect(r).toEqual({ kind: "ok", value: 1 });
  });

  it("returns kind:'error' when the tool throws", async () => {
    const t = tool(() => { throw new Error("MCP down"); });
    const r = await executeInstantMetric(t, "up{}", "ds-1", undefined, 5000);
    expect(r.kind).toBe("error");
    expect(Number.isNaN(r.value)).toBe(true);
  });
});

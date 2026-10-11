import { describe, it, expect, vi } from "vitest";
import { executeInstantMetric, executeInstantLogs, type InstantResult } from "./instant-query.js";

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

// grafana-mcp shapes: content-wrapped JSON; Loki range samples are
// {timestamp, value} objects; upstream failures come back as isError text.
const mcp = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

describe("executeInstantLogs", () => {
  it("sends the query as `logql`, the argument grafana-mcp query_loki_logs reads", async () => {
    const t = tool(() => mcp({ data: [] }));
    await executeInstantLogs(t, 'sum(count_over_time({app="a"} |~ "error|fatal" [15m]))', "loki-1", undefined, 5000);
    const args = t.execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.logql).toBe('sum(count_over_time({app="a"} |~ "error|fatal" [15m]))');
    expect(args).not.toHaveProperty("expr");
    expect(args.queryType).toBe("metric");
  });

  it("reads the latest {timestamp, value} sample from a Loki metric result", async () => {
    const t = tool(() => mcp({ data: [{ values: [
      { timestamp: "1700000000.000", value: 731 },
      { timestamp: "1700000014.000", value: 1290 },
    ] }] }));
    const r = await executeInstantLogs(t, "q", "loki-1", undefined, 5000);
    expect(r).toEqual({ kind: "ok", value: 1290 });
  });

  it("returns kind:'empty' when Loki matched nothing", async () => {
    const t = tool(() => mcp({ data: [], hints: { summary: "The Loki query returned no log entries" } }));
    const r = await executeInstantLogs(t, "q", "loki-1", undefined, 5000);
    expect(r.kind).toBe("empty");
  });

  it("returns kind:'error' when the tool reports an upstream failure (isError)", async () => {
    const t = tool(() => ({
      isError: true,
      content: [{ type: "text", text: "loki API returned status code 400: parse error at line 1, col 42" }],
    }));
    const r = await executeInstantLogs(t, "q", "loki-1", undefined, 5000);
    expect(r.kind).toBe("error");
    expect(Number.isNaN(r.value)).toBe(true);
  });
});

describe("executeInstantMetric — tool-reported errors", () => {
  it("returns kind:'error' (not empty) when the tool reports isError", async () => {
    const t = tool(() => ({ isError: true, content: [{ type: "text", text: "bad_data: parse error" }] }));
    const r = await executeInstantMetric(t, "up{", "ds-1", undefined, 5000);
    expect(r.kind).toBe("error");
  });
});

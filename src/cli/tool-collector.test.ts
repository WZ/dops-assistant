import { describe, it, expect } from "vitest";
import { createToolCollector } from "./tool-collector.js";

describe("createToolCollector", () => {
  it("collects tool calls in non-verbose mode", () => {
    const collector = createToolCollector(false);
    collector.callback("search_dashboards", { query: "api-gateway" }, "result-data", 340, undefined, "anomaly");
    collector.callback("query_prometheus", { expr: "up{job='api'}" }, "metric-data", 520, undefined, "metrics");

    const records = collector.getRecords();
    expect(records).toEqual([
      { name: "search_dashboards", argsSummary: '{"query":"api-gateway"}', durationMs: 340 },
      { name: "query_prometheus", argsSummary: '{"expr":"up{job=\'api\'}"}', durationMs: 520 },
    ]);
  });

  it("truncates argsSummary to 80 chars in non-verbose mode", () => {
    const collector = createToolCollector(false);
    const longArgs = { query: "a".repeat(200) };
    collector.callback("tool", longArgs);

    const records = collector.getRecords();
    expect(records[0]!.argsSummary.length).toBeLessThanOrEqual(83); // 80 + "..."
  });

  it("includes full details in verbose mode", () => {
    const collector = createToolCollector(true);
    collector.callback("tool", { q: "x" }, "big-result", 100, undefined, "planning");

    const records = collector.getRecords();
    expect(records[0]).toEqual({
      name: "tool",
      argsSummary: '{"q":"x"}',
      durationMs: 100,
      result: "big-result",
      phase: "planning",
    });
  });

  it("includes error in verbose mode when present", () => {
    const collector = createToolCollector(true);
    collector.callback("tool", {}, undefined, 50, "connection refused", "prefetch");

    const records = collector.getRecords();
    expect(records[0]!.error).toBe("connection refused");
  });

  it("omits durationMs when undefined", () => {
    const collector = createToolCollector(false);
    collector.callback("tool", {});

    const records = collector.getRecords();
    expect(records[0]!.durationMs).toBeUndefined();
  });
});

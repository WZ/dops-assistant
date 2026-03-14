import { describe, it, expect } from "vitest";
import { truncateToolResponse, repairTruncatedJson, sanitizeToolResult, safeJsonParse } from "./processors.js";

describe("repairTruncatedJson", () => {
  it("returns valid JSON unchanged", () => {
    const valid = '{"severity":"high","summary":"Error spike"}';
    expect(repairTruncatedJson(valid)).toBe(valid);
  });

  it("repairs truncated string value", () => {
    const truncated = '{"severity":"high","summary":"Error spike at 14:';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.severity).toBe("high");
    expect(parsed.summary).toContain("Error spike");
  });

  it("repairs truncated array", () => {
    const truncated = '{"items":["a","b","c';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.items).toContain("a");
    expect(parsed.items).toContain("b");
  });

  it("repairs truncated nested object", () => {
    const truncated = '{"impact":{"duration":"25 min","description":"Error';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.impact.duration).toBe("25 min");
  });

  it("repairs truncated mid-key", () => {
    const truncated = '{"severity":"high","summ';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.severity).toBe("high");
  });

  it("returns original string if unrepairable", () => {
    const garbage = "not json at all";
    expect(repairTruncatedJson(garbage)).toBe(garbage);
  });
});

describe("truncateToolResponse", () => {
  it("passes through short responses unchanged", () => {
    const short = '{"status":"ok"}';
    expect(truncateToolResponse(short, "some_tool")).toBe(short);
  });

  it("compacts get_dashboard_by_uid to panel list", () => {
    const input = JSON.stringify({
      dashboard: {
        title: "My Dashboard",
        uid: "abc123",
        panels: [
          { id: 1, title: "Panel A", type: "timeseries", gridPos: { x: 0, y: 0 }, targets: [] },
          { id: 2, title: "Panel B", type: "graph", gridPos: { x: 0, y: 1 }, targets: [] },
        ],
      },
      meta: {},
    });
    const result = JSON.parse(truncateToolResponse(input, "get_dashboard_by_uid"));
    expect(result.title).toBe("My Dashboard");
    expect(result.uid).toBe("abc123");
    expect(result.panels).toHaveLength(2);
    expect(result.panels[0]).toEqual({ id: 1, title: "Panel A", type: "timeseries" });
    // Should not include gridPos, targets etc.
    expect(result.panels[0].gridPos).toBeUndefined();
  });

  it("compacts search_dashboards to uid+title pairs capped at 20", () => {
    const dashboards = Array.from({ length: 25 }, (_, i) => ({
      uid: `uid${i}`,
      title: `Dashboard ${i}`,
      folderTitle: "Folder",
      tags: ["tag"],
    }));
    const input = JSON.stringify({ dashboards });
    const result = JSON.parse(truncateToolResponse(input, "search_dashboards"));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(20);
    expect(result[0]).toEqual({ uid: "uid0", title: "Dashboard 0" });
    expect(result[0].folderTitle).toBeUndefined();
  });

  it("compacts query_prometheus range query to stats + sampled values", () => {
    const values: [number, string][] = Array.from({ length: 200 }, (_, i) => [1700000000 + i * 60, String(i)]);
    const input = JSON.stringify({
      data: [{ metric: { __name__: "http_requests_total", job: "api" }, values }],
    });
    const result = JSON.parse(truncateToolResponse(input, "query_prometheus"));
    expect(result.data).toHaveLength(1);
    const item = result.data[0];
    expect(item.m).toBe("http_requests_total");
    expect(item.min).toBeDefined();
    expect(item.max).toBeDefined();
    expect(item.avg).toBeDefined();
    // Sampled to ~50 points — exact count depends on step
    expect(item.values.length).toBeLessThanOrEqual(51);
  });

  it("compacts query_loki_logs to line+timestamp+level", () => {
    const data = [
      { timestamp: "2026-01-01T00:00:00Z", line: "ERROR something failed", labels: { level: "error", app: "api" } },
      { timestamp: "2026-01-01T00:00:01Z", line: "INFO ok", labels: { app: "api" } },
    ];
    const input = JSON.stringify({ data, totalEntries: 2 });
    const result = JSON.parse(truncateToolResponse(input, "query_loki_logs"));
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({
      line: "ERROR something failed",
      timestamp: "2026-01-01T00:00:00Z",
      level: "error",
    });
    // No app label in output
    expect(result.data[0].labels).toBeUndefined();
  });

  it("truncates generic tools at 1500 chars", () => {
    const long = "x".repeat(3000);
    const result = truncateToolResponse(long, "some_unknown_tool");
    expect(result.length).toBeLessThan(2000);
    expect(result).toContain("[truncated,");
  });

  it("allows up to 12000 chars for query tools before truncating", () => {
    const medium = "x".repeat(2000);
    // Should NOT be truncated for a query tool
    expect(truncateToolResponse(medium, "query_prometheus")).toBe(medium);
  });
});

describe("truncateToolResponse — shape-based detection (tool-name-agnostic)", () => {
  it("detects dashboard JSON by shape regardless of tool name", () => {
    const input = JSON.stringify({
      dashboard: {
        title: "Infra Overview",
        uid: "dash-xyz",
        panels: [
          { id: 10, title: "CPU", type: "timeseries", gridPos: {}, targets: [] },
        ],
      },
      meta: {},
    });
    // Use an arbitrary tool name — shape detection should still pick it up
    const result = JSON.parse(truncateToolResponse(input, "any_unknown_tool"));
    expect(result.title).toBe("Infra Overview");
    expect(result.uid).toBe("dash-xyz");
    expect(result.panels).toHaveLength(1);
    expect(result.panels[0]).toEqual({ id: 10, title: "CPU", type: "timeseries" });
    expect(result.panels[0].gridPos).toBeUndefined();
  });

  it("detects time series data by shape regardless of tool name", () => {
    const values: [number, string][] = Array.from({ length: 100 }, (_, i) => [1700000000 + i * 60, String(i * 2)]);
    const input = JSON.stringify({
      data: [{ metric: { __name__: "cpu_usage", job: "node" }, values }],
    });
    const result = JSON.parse(truncateToolResponse(input, "custom_metrics_tool"));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].m).toBe("cpu_usage");
    expect(result.data[0].min).toBeDefined();
    expect(result.data[0].max).toBeDefined();
    expect(result.data[0].values.length).toBeLessThanOrEqual(51);
  });

  it("detects log lines by shape regardless of tool name", () => {
    const data = [
      { timestamp: "2026-01-01T00:00:00Z", line: "WARN high latency", labels: { level: "warn", pod: "api-1" } },
    ];
    const input = JSON.stringify({ data });
    const result = JSON.parse(truncateToolResponse(input, "custom_logs_tool"));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].line).toBe("WARN high latency");
    expect(result.data[0].level).toBe("warn");
    expect(result.data[0].labels).toBeUndefined();
  });

  it("detects search results by shape regardless of tool name", () => {
    const list = Array.from({ length: 30 }, (_, i) => ({
      uid: `uid-${i}`,
      title: `Board ${i}`,
      folderTitle: "ops",
    }));
    const input = JSON.stringify(list); // flat array, no wrapper key
    const result = JSON.parse(truncateToolResponse(input, "find_dashboards"));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(20);
    expect(result[0]).toEqual({ uid: "uid-0", title: "Board 0" });
    expect(result[0].folderTitle).toBeUndefined();
  });

  it("detects wrapped search results (dashboards key)", () => {
    const dashboards = Array.from({ length: 5 }, (_, i) => ({ uid: `u${i}`, title: `T${i}`, extra: "x" }));
    const input = JSON.stringify({ dashboards });
    const result = JSON.parse(truncateToolResponse(input, "some_search_tool"));
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toEqual({ uid: "u0", title: "T0" });
    expect(result[0].extra).toBeUndefined();
  });

  it("falls through to generic truncation for unrecognized shapes", () => {
    const plain = JSON.stringify({ status: "ok", code: 200 });
    expect(truncateToolResponse(plain, "health_check")).toBe(plain);
  });

  it("instant-query time series (value not values) compacted correctly", () => {
    const input = JSON.stringify({
      data: [{ metric: { __name__: "up", job: "api", instance: "host1" }, value: [1700000000, "1"] }],
    });
    const result = JSON.parse(truncateToolResponse(input, "instant_query_tool"));
    expect(result.data[0].m).toBe("up");
    expect(result.data[0].v).toBe("1");
    expect(result.data[0].t).toBe(1700000000);
  });
});

describe("sanitizeToolResult", () => {
  it("passes through clean text unchanged", () => {
    const text = "CPU usage is 80%";
    expect(sanitizeToolResult(text)).toBe(text);
  });

  it("strips inline base64 data URIs", () => {
    const b64 = "A".repeat(150);
    const text = `data:image/png;base64,${b64}`;
    const result = sanitizeToolResult(text);
    expect(result).toContain("[base64 image removed]");
    expect(result).not.toContain("data:image/png");
  });

  it("strips raw base64 blobs over 200 chars", () => {
    const blob = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".repeat(4); // 256 chars
    const text = `result: ${blob}`;
    const result = sanitizeToolResult(text);
    expect(result).toContain("[large blob removed]");
  });

  it("truncates oversized results at 8000 chars", () => {
    // Use a string that won't be caught by base64 blob regex (contains spaces and special chars)
    const long = "metric value: 123\n".repeat(600); // ~10800 chars with non-base64 chars
    const result = sanitizeToolResult(long);
    expect(result.length).toBeLessThan(8100);
    expect(result).toContain("...[truncated]");
  });

  it("does not strip base64-like strings under 200 chars", () => {
    const short = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk"; // < 200 chars
    expect(sanitizeToolResult(short)).toBe(short);
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON directly", () => {
    const result = safeJsonParse('{"isAnomaly":true,"severity":"high"}');
    expect(result).toEqual({ isAnomaly: true, severity: "high" });
  });

  it("extracts JSON from a markdown json code block", () => {
    const text = 'Here is the result:\n```json\n{"summary":"CPU spike","observations":[]}\n```';
    const result = safeJsonParse(text);
    expect(result).toEqual({ summary: "CPU spike", observations: [] });
  });

  it("extracts JSON from a plain markdown code block (no language tag)", () => {
    const text = "Analysis complete:\n```\n{\"rootCause\":\"Memory leak\"}\n```";
    const result = safeJsonParse(text);
    expect(result).toEqual({ rootCause: "Memory leak" });
  });

  it("extracts first JSON object from free-form text", () => {
    const text = 'After analysis I found: {"severity":"medium","summary":"Error spike"} — end of report.';
    const result = safeJsonParse(text);
    expect(result).toEqual({ severity: "medium", summary: "Error spike" });
  });

  it("returns null for pure prose with no JSON", () => {
    const result = safeJsonParse("I cannot determine the root cause.");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(safeJsonParse("")).toBeNull();
  });

  it("returns null for malformed JSON with no valid fallback", () => {
    expect(safeJsonParse("{broken: json}")).toBeNull();
  });

  it("parses JSON with nested objects", () => {
    const text = JSON.stringify({
      hypotheses: [{ hypothesis: "DB overload", evidenceNeeded: "slow query logs" }],
      metricFocus: ["latency"],
      logFocus: ["db errors"],
      infraFocus: [],
    });
    const result = safeJsonParse(text);
    expect(result?.hypotheses).toHaveLength(1);
    expect(result?.hypotheses[0].hypothesis).toBe("DB overload");
    expect(result?.metricFocus).toEqual(["latency"]);
  });

  it("prefers direct parse over code block extraction when text is valid JSON", () => {
    // Even if the valid JSON happens to contain backtick-like sequences, direct parse wins
    const valid = '{"key":"value"}';
    expect(safeJsonParse(valid)).toEqual({ key: "value" });
  });
});

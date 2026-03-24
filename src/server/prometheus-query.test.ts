import { describe, it, expect, vi, beforeEach } from "vitest";
import { queryServiceMetrics, type MetricSeries } from "./prometheus-query.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock getToolsByRole — returns a record of tool name → tool executor
vi.mock("../mcp/provider.js", () => ({
  getToolsByRole: vi.fn(),
}));

// Mock parsePrometheusResult — controls what "Prometheus" returns
vi.mock("./service-health-poller.js", () => ({
  parsePrometheusResult: vi.fn(),
}));

import { getToolsByRole } from "../mcp/provider.js";
import { parsePrometheusResult } from "./service-health-poller.js";

const mockGetToolsByRole = getToolsByRole as ReturnType<typeof vi.fn>;
const mockParseResult = parsePrometheusResult as ReturnType<typeof vi.fn>;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockTool(fn: (args: unknown) => unknown = () => ({})) {
  return { execute: vi.fn(async (args: unknown) => fn(args)) };
}

function makeRangeValues(count: number, baseValue = 100): [number, string][] {
  const now = Date.now() / 1000;
  return Array.from({ length: count }, (_, i) => [
    now - (count - i) * 60,
    String(baseValue + i),
  ]);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("prometheus-query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── queryServiceMetrics: happy path ────────────────────────────────────

  describe("queryServiceMetrics — happy path", () => {
    it("returns metrics from default queries when no registry metrics provided", async () => {
      const queryTool = makeMockTool();
      const dsTool = makeMockTool(() => ({
        content: [{ type: "text", text: JSON.stringify({ datasources: [{ type: "prometheus", uid: "prom-1" }] }) }],
      }));

      mockGetToolsByRole.mockResolvedValue({
        query_prometheus: queryTool,
        list_datasources: dsTool,
      });

      const values = makeRangeValues(5, 100);
      mockParseResult.mockReturnValue([{ metric: {}, values }]);

      const result = await queryServiceMetrics("payments-api", "1h", []);

      // Should produce 3 default queries: Request Rate, Error Rate, Pod Replicas
      expect(result).toHaveLength(3);
      expect(result[0]!.name).toBe("Request Rate");
      expect(result[1]!.name).toBe("Error Rate");
      expect(result[2]!.name).toBe("Pod Replicas");

      // Each should have parsed values
      expect(result[0]!.values.length).toBe(5);
      expect(result[0]!.current).toBeCloseTo(104);
      expect(result[0]!.min).toBeCloseTo(100);
      expect(result[0]!.max).toBeCloseTo(104);
      expect(result[0]!.avg).toBeCloseTo(102);
    });

    it("uses registry metrics when provided", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });
      mockParseResult.mockReturnValue([{ metric: {}, values: makeRangeValues(3, 50) }]);

      const registryMetrics = [
        { query: 'rate(custom_metric_total{job="payments"}[5m])', description: "Custom Rate" },
      ];

      const result = await queryServiceMetrics("payments-api", "24h", [], registryMetrics);

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("Custom Rate");
      expect(result[0]!.unit).toBe("req/s"); // inferred from rate()
    });

    it("infers metric name when registry description is empty", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });
      mockParseResult.mockReturnValue([{ metric: {}, value: [1234, "42"] }]);

      const registryMetrics = [
        { query: "up{job=\"payments\"}", description: "" },
      ];

      const result = await queryServiceMetrics("payments-api", "1h", [], registryMetrics);

      expect(result).toHaveLength(1);
      // inferMetricName should extract "up" from the query
      expect(result[0]!.name).toBe("up");
    });
  });

  // ── PromQL sanitization ────────────────────────────────────────────────

  describe("PromQL sanitization", () => {
    it("strips unsafe characters from service names in default queries", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });
      mockParseResult.mockReturnValue([]);

      // Service name with PromQL injection characters
      await queryServiceMetrics('my-svc"})) or (vector(1', "1h", []);

      // Verify queries sent to the tool only contain safe characters
      const calls = queryTool.execute.mock.calls;
      for (const [args] of calls) {
        const expr = (args as Record<string, unknown>).expr as string;
        // The raw injection string should NOT appear
        expect(expr).not.toContain('"}))');
        expect(expr).not.toContain("vector(1");
        // The sanitized version should appear
        expect(expr).toContain("my-svc");
      }
    });

    it("preserves valid service name characters", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });
      mockParseResult.mockReturnValue([]);

      await queryServiceMetrics("my-service_v2.0", "1h", []);

      const calls = queryTool.execute.mock.calls;
      const expr = (calls[0]![0] as Record<string, unknown>).expr as string;
      expect(expr).toContain("my-service_v2.0");
    });
  });

  // ── Graceful degradation ───────────────────────────────────────────────

  describe("graceful degradation", () => {
    it("returns empty array when getToolsByRole fails", async () => {
      mockGetToolsByRole.mockRejectedValue(new Error("No providers"));

      const result = await queryServiceMetrics("svc", "1h", []);
      expect(result).toEqual([]);
    });

    it("returns empty array when query_prometheus tool not found", async () => {
      mockGetToolsByRole.mockResolvedValue({ some_other_tool: makeMockTool() });

      const result = await queryServiceMetrics("svc", "1h", []);
      expect(result).toEqual([]);
    });

    it("returns empty metrics when individual query execution fails", async () => {
      const queryTool = makeMockTool(() => { throw new Error("MCP error"); });
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });
      mockParseResult.mockImplementation(() => { throw new Error("Parse error"); });

      const result = await queryServiceMetrics("svc", "1h", []);

      // Should still return 3 entries (default queries), each with empty values
      expect(result).toHaveLength(3);
      for (const m of result) {
        expect(m.values).toEqual([]);
        expect(m.current).toBe(0);
      }
    });

    it("returns empty values when Prometheus returns no data", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });
      mockParseResult.mockReturnValue([]);

      const result = await queryServiceMetrics("svc", "1h", []);

      expect(result).toHaveLength(3);
      for (const m of result) {
        expect(m.values).toEqual([]);
        expect(m.current).toBe(0);
        expect(m.min).toBeUndefined();
        expect(m.max).toBeUndefined();
        expect(m.avg).toBeUndefined();
      }
    });
  });

  // ── Range fallback to instant ──────────────────────────────────────────

  describe("range → instant fallback", () => {
    it("falls back to instant query when range query returns no values", async () => {
      // Use queryType from the tool args to distinguish range vs instant calls
      const queryTool = makeMockTool((args) => {
        return (args as Record<string, unknown>).queryType; // "range" or "instant"
      });
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });

      mockParseResult.mockImplementation((raw: unknown) => {
        if (raw === "range") return []; // range: no data → triggers fallback
        if (raw === "instant") return [{ metric: {}, value: [1711100000, "42.5"] }];
        return [];
      });

      const result = await queryServiceMetrics("svc", "1h", []);

      expect(result).toHaveLength(3);
      // Each metric should have called execute twice (range + instant fallback)
      expect(queryTool.execute).toHaveBeenCalledTimes(6); // 3 queries × 2 attempts
      // Each metric should have a valid current value from the instant fallback
      for (const m of result) {
        expect(m.current).toBeCloseTo(42.5);
      }
    });

    it("handles instant-style result within range response", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });

      // Range query returns a single instant value (value instead of values)
      mockParseResult.mockReturnValue([{ metric: {}, value: [1711100000, "99.9"] }]);

      const result = await queryServiceMetrics("svc", "1h", []);

      expect(result[0]!.current).toBeCloseTo(99.9);
      expect(result[0]!.values).toHaveLength(1);
    });
  });

  // ── Datasource discovery ───────────────────────────────────────────────

  describe("datasource discovery", () => {
    it("passes datasourceUid to query tool when found", async () => {
      const queryTool = makeMockTool();
      const dsTool = makeMockTool(() => ({
        content: [{ type: "text", text: JSON.stringify([{ type: "prometheus", uid: "ds-42" }]) }],
      }));

      mockGetToolsByRole.mockResolvedValue({
        grafana_list_datasources: dsTool,
        query_prometheus: queryTool,
      });
      mockParseResult.mockReturnValue([]);

      await queryServiceMetrics("svc", "1h", []);

      // All query calls should include datasourceUid
      for (const [args] of queryTool.execute.mock.calls) {
        expect((args as Record<string, unknown>).datasourceUid).toBe("ds-42");
      }
    });

    it("queries without datasourceUid when list_datasources not available", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });
      mockParseResult.mockReturnValue([]);

      await queryServiceMetrics("svc", "1h", []);

      for (const [args] of queryTool.execute.mock.calls) {
        expect((args as Record<string, unknown>).datasourceUid).toBeUndefined();
      }
    });

    it("handles wrapped datasource response format", async () => {
      const queryTool = makeMockTool();
      // Grafana MCP returns { datasources: [...] } not a flat array
      const dsTool = makeMockTool(() => ({
        content: [{ type: "text", text: JSON.stringify({ datasources: [{ type: "prometheus", uid: "wrapped-uid" }] }) }],
      }));

      mockGetToolsByRole.mockResolvedValue({
        list_datasources: dsTool,
        query_prometheus: queryTool,
      });
      mockParseResult.mockReturnValue([]);

      await queryServiceMetrics("svc", "1h", []);

      for (const [args] of queryTool.execute.mock.calls) {
        expect((args as Record<string, unknown>).datasourceUid).toBe("wrapped-uid");
      }
    });
  });

  // ── Range and step computation ─────────────────────────────────────────

  describe("range and step computation", () => {
    it("uses correct step for 1h range (~30s)", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });
      mockParseResult.mockReturnValue([]);

      await queryServiceMetrics("svc", "1h", []);

      const args = queryTool.execute.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.step).toBe("30s"); // Math.max(15, floor(3600/120)) = 30
    });

    it("uses correct step for 7d range (~5040s)", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });
      mockParseResult.mockReturnValue([]);

      await queryServiceMetrics("svc", "7d", []);

      const args = queryTool.execute.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.step).toBe("5040s"); // Math.max(15, floor(604800/120)) = 5040
    });

    it("defaults to 24h for unknown range string", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });
      mockParseResult.mockReturnValue([]);

      await queryServiceMetrics("svc", "99d", []);

      const args = queryTool.execute.mock.calls[0]![0] as Record<string, unknown>;
      // 86400 / 120 = 720
      expect(args.step).toBe("720s");
    });
  });

  // ── Min/max/avg computation ────────────────────────────────────────────

  describe("statistics computation", () => {
    it("computes min, max, avg from values", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });

      const values: [number, string][] = [
        [1000, "10"],
        [1060, "20"],
        [1120, "30"],
        [1180, "NaN"], // should be filtered
        [1240, "40"],
      ];
      mockParseResult.mockReturnValue([{ metric: {}, values }]);

      const result = await queryServiceMetrics("svc", "1h", []);

      expect(result[0]!.min).toBe(10);
      expect(result[0]!.max).toBe(40);
      expect(result[0]!.avg).toBe(25); // (10+20+30+40)/4
    });

    it("handles all NaN values gracefully", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({ query_prometheus: queryTool });

      const values: [number, string][] = [
        [1000, "NaN"],
        [1060, "NaN"],
      ];
      mockParseResult.mockReturnValue([{ metric: {}, values }]);

      const result = await queryServiceMetrics("svc", "1h", []);

      // NaN values are filtered out, leaving empty nums array
      expect(result[0]!.min).toBeUndefined();
      expect(result[0]!.max).toBeUndefined();
      expect(result[0]!.avg).toBeUndefined();
    });
  });

  // ── Tool name matching ─────────────────────────────────────────────────

  describe("tool name matching", () => {
    it("finds query_prometheus with prefix (e.g., grafana_query_prometheus)", async () => {
      const queryTool = makeMockTool();
      mockGetToolsByRole.mockResolvedValue({
        grafana_mcp_query_prometheus: queryTool,
        other_tool: makeMockTool(),
      });
      mockParseResult.mockReturnValue([]);

      const result = await queryServiceMetrics("svc", "1h", []);

      // Should use the tool matching _query_prometheus suffix
      expect(queryTool.execute).toHaveBeenCalled();
      expect(result).toHaveLength(3);
    });
  });
});

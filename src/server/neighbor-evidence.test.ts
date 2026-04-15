import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectNeighborsForEvidenceFetch, fetchNeighborEvidence } from "./neighbor-evidence.js";
import type { Neighbor } from "../types/workflow-state.js";

// Mock the role-based tool loader so we never touch real providers.
vi.mock("../mcp/provider.js", async (orig) => {
  const actual = await (orig as any)();
  return {
    ...actual,
    getToolsByRole: vi.fn(),
  };
});
// Mock queryServiceMetrics so we don't drag in the whole prometheus-query code path.
vi.mock("./prometheus-query.js", () => ({
  queryServiceMetrics: vi.fn(),
}));
import { getToolsByRole } from "../mcp/provider.js";
import { queryServiceMetrics } from "./prometheus-query.js";
const mockGetToolsByRole = getToolsByRole as unknown as ReturnType<typeof vi.fn>;
const mockQueryServiceMetrics = queryServiceMetrics as unknown as ReturnType<typeof vi.fn>;

function mkNeighbor(
  name: string,
  status: Neighbor["status"],
  options: Partial<Neighbor> = {},
): Neighbor {
  return {
    name,
    status,
    directions: ["downstream"],
    inServiceRegistry: true,
    ...options,
  };
}

describe("selectNeighborsForEvidenceFetch", () => {
  it("drops healthy neighbors by default", () => {
    const input = [
      mkNeighbor("a", "healthy"),
      mkNeighbor("b", "degraded"),
      mkNeighbor("c", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input);
    expect(out.map((n) => n.name)).toEqual(["c", "b"]);
  });

  it("drops neighbors not in the service registry by default", () => {
    const input = [
      mkNeighbor("a", "unhealthy", { inServiceRegistry: false }),
      mkNeighbor("b", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input);
    expect(out.map((n) => n.name)).toEqual(["b"]);
  });

  it("respects maxNeighbors hard cap", () => {
    const input = [
      mkNeighbor("a", "unhealthy"),
      mkNeighbor("b", "unhealthy"),
      mkNeighbor("c", "unhealthy"),
      mkNeighbor("d", "unhealthy"),
      mkNeighbor("e", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input, { maxNeighbors: 2 });
    expect(out).toHaveLength(2);
  });

  it("sorts by severity first (unhealthy > degraded > unknown > healthy)", () => {
    const input = [
      mkNeighbor("u", "unknown"),
      mkNeighbor("d", "degraded"),
      mkNeighbor("c", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input);
    expect(out.map((n) => n.name)).toEqual(["c", "d", "u"]);
  });

  it("uses requestRate as a tiebreaker within the same severity", () => {
    const input = [
      mkNeighbor("low", "unhealthy", { requestRate: "10" }),
      mkNeighbor("high", "unhealthy", { requestRate: "500" }),
      mkNeighbor("mid", "unhealthy", { requestRate: "50" }),
    ];
    const out = selectNeighborsForEvidenceFetch(input);
    expect(out.map((n) => n.name)).toEqual(["high", "mid", "low"]);
  });

  it("treats missing requestRate as 0 for ranking", () => {
    const input = [
      mkNeighbor("norate", "unhealthy"),
      mkNeighbor("withrate", "unhealthy", { requestRate: "5" }),
    ];
    const out = selectNeighborsForEvidenceFetch(input);
    expect(out.map((n) => n.name)).toEqual(["withrate", "norate"]);
  });

  it("minStatus=unhealthy excludes degraded and unknown", () => {
    const input = [
      mkNeighbor("u", "unknown"),
      mkNeighbor("d", "degraded"),
      mkNeighbor("c", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input, { minStatus: "unhealthy" });
    expect(out.map((n) => n.name)).toEqual(["c"]);
  });

  it("requireInRegistry=false keeps off-registry neighbors", () => {
    const input = [
      mkNeighbor("a", "unhealthy", { inServiceRegistry: false }),
      mkNeighbor("b", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input, { requireInRegistry: false });
    expect(out).toHaveLength(2);
  });
});

describe("fetchNeighborEvidence (graceful fallbacks)", () => {
  beforeEach(() => {
    mockGetToolsByRole.mockReset();
    mockQueryServiceMetrics.mockReset();
  });

  it("records fetchErrors when logs-role provider is missing", async () => {
    // No metrics returned, no logs provider at all
    mockQueryServiceMetrics.mockResolvedValue([]);
    mockGetToolsByRole.mockImplementation(async (_providers: unknown, role: string) => {
      if (role === "logs") return {};
      return {};
    });

    const n: Neighbor = {
      name: "kafka-broker-0",
      directions: ["downstream"],
      status: "unhealthy",
      inServiceRegistry: true,
    };
    const result = await fetchNeighborEvidence(n, [], []);

    expect(result.metrics).toEqual([]);
    expect(result.logs).toEqual([]);
    // Should have recorded both the empty-metrics soft error and the missing-logs-provider error
    expect(result.fetchErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.fetchErrors.some((e) => e.includes("logs:"))).toBe(true);
    expect(result.fetchedAt).toBeTruthy();
  });

  it("records fetchErrors when the metrics query throws", async () => {
    mockQueryServiceMetrics.mockRejectedValue(new Error("MCP unreachable"));
    mockGetToolsByRole.mockResolvedValue({});

    const n: Neighbor = {
      name: "redis-primary",
      directions: ["downstream"],
      status: "degraded",
      inServiceRegistry: true,
    };
    const result = await fetchNeighborEvidence(n, [], []);

    expect(result.fetchErrors.some((e) => e.includes("metrics:") && e.includes("MCP unreachable"))).toBe(true);
    // Function does not throw — it returns a populated NeighborEvidence with errors.
    expect(result.metrics).toEqual([]);
  });

  it("packages metric samples from queryServiceMetrics results", async () => {
    mockQueryServiceMetrics.mockResolvedValue([
      {
        name: "Request Rate",
        query: 'rate(http_requests_total{service="kafka-broker-0"}[5m])',
        unit: "req/s",
        current: 42,
        values: [
          ["1714060800", 42],
          ["1714060815", 41],
        ],
        fetchedAt: Date.now(),
      },
    ]);
    mockGetToolsByRole.mockResolvedValue({});

    const n: Neighbor = {
      name: "kafka-broker-0",
      directions: ["downstream"],
      status: "unhealthy",
      inServiceRegistry: true,
    };
    const result = await fetchNeighborEvidence(n, [], []);

    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]!.query).toContain("kafka-broker-0");
    expect(result.metrics[0]!.values[0]).toEqual(["1714060800", "42"]);
  });
});

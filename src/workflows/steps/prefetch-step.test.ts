import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LanguageModel } from "ai";

// Mock executePrefetch so we never touch real MCP providers.
vi.mock("./prefetch.js", () => ({
  executePrefetch: vi.fn().mockResolvedValue({
    datasourceHints: "Prometheus uid=prom-1",
    dashboardContext: "",
    panelQueryHints: "",
    logLabelHints: "",
    workingLogSelectors: [],
    neighbors: [],
  }),
}));

// Mock the Coroot + neighbor-evidence modules so we can control what prefetch composes.
vi.mock("../../server/coroot.js", () => ({
  fetchCorootNeighbors: vi.fn(),
}));
vi.mock("../../server/neighbor-evidence.js", () => ({
  selectNeighborsForEvidenceFetch: vi.fn(),
  fetchNeighborEvidence: vi.fn(),
}));

import { buildPrefetchStep } from "./prefetch-step.js";
import { fetchCorootNeighbors } from "../../server/coroot.js";
import {
  selectNeighborsForEvidenceFetch,
  fetchNeighborEvidence,
} from "../../server/neighbor-evidence.js";
import type { Neighbor } from "../../types/workflow-state.js";

const mockFetchCorootNeighbors = fetchCorootNeighbors as unknown as ReturnType<typeof vi.fn>;
const mockSelectNeighbors = selectNeighborsForEvidenceFetch as unknown as ReturnType<typeof vi.fn>;
const mockFetchNeighborEvidence = fetchNeighborEvidence as unknown as ReturnType<typeof vi.fn>;

const fakeModel = {} as LanguageModel;

function makeStepCtx(inputData: unknown) {
  return {
    inputData,
    runId: "test-run",
    workflowId: "investigation",
    mastra: {} as any,
    requestContext: {} as any,
    state: {} as any,
    setState: async () => {},
    suspend: async () => {},
  } as any;
}

function makeConfig(overrides: Partial<Parameters<typeof buildPrefetchStep>[0]> = {}) {
  return {
    model: fakeModel,
    providers: [],
    services: [],
    ...overrides,
  };
}

const baseInput = {
  userMessage: "investigate ingestion-server",
  serviceName: "ingestion-server",
  alertName: undefined,
  skillContext: undefined,
};

describe("buildPrefetchStep — Coroot neighbor composition", () => {
  beforeEach(() => {
    mockFetchCorootNeighbors.mockReset();
    mockSelectNeighbors.mockReset();
    mockFetchNeighborEvidence.mockReset();
  });

  it("returns empty neighbors when no serviceName is provided (anomaly mode)", async () => {
    mockSelectNeighbors.mockReturnValue([]);
    const step = buildPrefetchStep(makeConfig());
    const result = (await step.execute(
      makeStepCtx({ ...baseInput, serviceName: undefined }),
    )) as any;
    expect(result.neighbors).toEqual([]);
    // fetchCorootNeighbors must not be called when serviceName is missing
    expect(mockFetchCorootNeighbors).not.toHaveBeenCalled();
  });

  it("returns empty neighbors when Coroot provider is absent (fetchCorootNeighbors returns null)", async () => {
    mockFetchCorootNeighbors.mockResolvedValue(null);
    mockSelectNeighbors.mockReturnValue([]);
    const step = buildPrefetchStep(makeConfig());
    const result = (await step.execute(makeStepCtx(baseInput))) as any;
    expect(result.neighbors).toEqual([]);
    expect(mockFetchCorootNeighbors).toHaveBeenCalledWith("ingestion-server", [], []);
    expect(mockFetchNeighborEvidence).not.toHaveBeenCalled();
  });

  it("returns empty neighbors when Coroot fetch throws (graceful fallback)", async () => {
    mockFetchCorootNeighbors.mockRejectedValue(new Error("Coroot unreachable"));
    mockSelectNeighbors.mockReturnValue([]);
    const step = buildPrefetchStep(makeConfig());
    const result = (await step.execute(makeStepCtx(baseInput))) as any;
    expect(result.neighbors).toEqual([]);
    // Must not throw — graceful degradation per design doc
  });

  it("passes discovered neighbors unchanged when none are selected for enrichment", async () => {
    const neighbors: Neighbor[] = [
      {
        name: "web-frontend",
        directions: ["upstream"],
        status: "healthy",
        inServiceRegistry: true,
      },
    ];
    mockFetchCorootNeighbors.mockResolvedValue(neighbors);
    mockSelectNeighbors.mockReturnValue([]); // no neighbors selected for evidence fetch
    const step = buildPrefetchStep(makeConfig());
    const result = (await step.execute(makeStepCtx(baseInput))) as any;
    expect(result.neighbors).toHaveLength(1);
    expect(result.neighbors[0].name).toBe("web-frontend");
    expect(result.neighbors[0].evidence).toBeUndefined();
    expect(mockFetchNeighborEvidence).not.toHaveBeenCalled();
  });

  it("enriches selected neighbors with fetched evidence (happy path)", async () => {
    const kafka0: Neighbor = {
      name: "kafka-broker-0",
      directions: ["downstream"],
      status: "unhealthy",
      inServiceRegistry: true,
      requestRate: "0",
    };
    const kafka1: Neighbor = {
      name: "kafka-broker-1",
      directions: ["downstream"],
      status: "unhealthy",
      inServiceRegistry: true,
      requestRate: "0",
    };
    const healthy: Neighbor = {
      name: "web-frontend",
      directions: ["upstream"],
      status: "healthy",
      inServiceRegistry: true,
    };
    mockFetchCorootNeighbors.mockResolvedValue([kafka0, kafka1, healthy]);
    // Select only the two unhealthy ones
    mockSelectNeighbors.mockReturnValue([kafka0, kafka1]);
    // Each evidence fetch returns a populated structure
    mockFetchNeighborEvidence.mockImplementation(async (n: Neighbor) => ({
      metrics: [
        { query: `up{service="${n.name}"}`, values: [["1714060800", "0"] as [string, string]] },
      ],
      logs: [],
      fetchedAt: "2026-04-15T10:00:00Z",
      fetchErrors: [],
    }));

    const step = buildPrefetchStep(makeConfig());
    const result = (await step.execute(makeStepCtx(baseInput))) as any;

    // Should call fetchNeighborEvidence for each selected neighbor (2 in parallel)
    expect(mockFetchNeighborEvidence).toHaveBeenCalledTimes(2);

    // All 3 neighbors still returned, but only the 2 selected got evidence
    expect(result.neighbors).toHaveLength(3);
    const byName = new Map(result.neighbors.map((n: Neighbor) => [n.name, n]));
    expect((byName.get("kafka-broker-0") as Neighbor).evidence).toBeDefined();
    expect((byName.get("kafka-broker-1") as Neighbor).evidence).toBeDefined();
    expect((byName.get("web-frontend") as Neighbor).evidence).toBeUndefined();
  });

  it("captures per-neighbor evidence fetch errors without failing the whole step", async () => {
    const kafka: Neighbor = {
      name: "kafka-broker-0",
      directions: ["downstream"],
      status: "unhealthy",
      inServiceRegistry: true,
    };
    mockFetchCorootNeighbors.mockResolvedValue([kafka]);
    mockSelectNeighbors.mockReturnValue([kafka]);
    // fetchNeighborEvidence throws — prefetch-step must still return a valid result
    mockFetchNeighborEvidence.mockRejectedValue(new Error("MCP timeout"));

    const step = buildPrefetchStep(makeConfig());
    const result = (await step.execute(makeStepCtx(baseInput))) as any;

    expect(result.neighbors).toHaveLength(1);
    const enriched = result.neighbors[0];
    expect(enriched.name).toBe("kafka-broker-0");
    expect(enriched.evidence).toBeDefined();
    expect(enriched.evidence.metrics).toEqual([]);
    expect(enriched.evidence.logs).toEqual([]);
    expect(enriched.evidence.fetchErrors.length).toBeGreaterThan(0);
    expect(enriched.evidence.fetchErrors[0]).toContain("MCP timeout");
  });

  it("passes serviceName through the output for downstream steps", async () => {
    mockFetchCorootNeighbors.mockResolvedValue([]);
    mockSelectNeighbors.mockReturnValue([]);
    const step = buildPrefetchStep(makeConfig());
    const result = (await step.execute(makeStepCtx(baseInput))) as any;
    expect(result.serviceName).toBe("ingestion-server");
    expect(result.userMessage).toBe("investigate ingestion-server");
  });

  it("does not mutate its inputs — returns a fresh neighbors array on every call", async () => {
    const original: Neighbor[] = [
      {
        name: "kafka-broker-0",
        directions: ["downstream"],
        status: "unhealthy",
        inServiceRegistry: true,
      },
    ];
    mockFetchCorootNeighbors.mockResolvedValue(original);
    mockSelectNeighbors.mockReturnValue([]);

    const step = buildPrefetchStep(makeConfig());
    const result1 = (await step.execute(makeStepCtx(baseInput))) as any;
    const result2 = (await step.execute(makeStepCtx(baseInput))) as any;

    // Different references — prevents cross-investigation contamination if
    // fetchCorootNeighbors happened to return the same reference twice.
    expect(result1.neighbors).not.toBe(result2.neighbors);
  });
});

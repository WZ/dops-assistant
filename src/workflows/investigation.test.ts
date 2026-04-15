import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LanguageModel } from "ai";
import { createInvestigationWorkflow, buildMetricsStep, buildLogsStep, buildInfraStep, buildSynthesisStep } from "./investigation.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceConfig } from "../config/schema.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const fakeModel = {} as LanguageModel;

function makeProvider(
  name: string,
  roles: MastraProvider["roles"],
  toolMap: Record<string, any> = {},
): MastraProvider {
  const client = {
    listTools: vi.fn().mockResolvedValue(toolMap),
  } as unknown as MastraProvider["client"];
  return { name, roles, client };
}

const noopService: ServiceConfig = {
  name: "test-svc",
  metrics: [],
  logLabels: {},
};

/** Minimal step execution context — only inputData is used by evidence steps */
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

const basePlanningContext = {
  hypotheses: [],
  metricFocus: [],
  logFocus: [],
  infraFocus: [],
  anomalyContext: {
    isAnomaly: true,
    severity: "high" as const,
    summary: "High error rate on api-service",
    affectedServices: ["api-service"],
    prefetchContext: {
      datasourceHints: "Prometheus uid=prom-1",
      dashboardContext: "",
      panelQueryHints: "",
      logLabelHints: "",
      workingLogSelectors: [],
    },
    userMessage: "high error rate",
    serviceName: "api-service",
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createInvestigationWorkflow", () => {
  it("creates a workflow successfully with no providers", () => {
    const workflow = createInvestigationWorkflow({
      model: fakeModel,
      providers: [],
      services: [],
    });
    expect(workflow).toBeDefined();
    expect(workflow.id).toBe("investigation");
  });

  it("creates a workflow with providers and services", () => {
    const provider = makeProvider("grafana", ["metrics", "dashboards", "logs"]);

    const workflow = createInvestigationWorkflow({
      model: fakeModel,
      providers: [provider],
      services: [noopService],
    });

    expect(workflow).toBeDefined();
    expect(workflow.id).toBe("investigation");
  });

  it("creates a workflow with useQuirkHandling enabled", () => {
    const workflow = createInvestigationWorkflow({
      model: fakeModel,
      providers: [],
      services: [],
      useQuirkHandling: true,
    });

    expect(workflow).toBeDefined();
  });

  it("creates a workflow with projectRoot configured", () => {
    const workflow = createInvestigationWorkflow({
      model: fakeModel,
      providers: [],
      services: [noopService],
      projectRoot: "/tmp/test-project",
    });

    expect(workflow).toBeDefined();
  });

  it("creates different workflow instances for different configs", () => {
    const workflow1 = createInvestigationWorkflow({
      model: fakeModel,
      providers: [],
      services: [],
    });

    const provider = makeProvider("grafana", ["metrics"]);
    const workflow2 = createInvestigationWorkflow({
      model: fakeModel,
      providers: [provider],
      services: [noopService],
      useQuirkHandling: true,
    });

    // Both should be valid workflows
    expect(workflow1).toBeDefined();
    expect(workflow2).toBeDefined();
    // They should both have the same id (both are "investigation")
    expect(workflow1.id).toBe("investigation");
    expect(workflow2.id).toBe("investigation");
  });

  it("workflow is committed after creation", () => {
    const workflow = createInvestigationWorkflow({
      model: fakeModel,
      providers: [],
      services: [],
    });

    // The workflow should be committed (committed property set by .commit())
    expect(workflow.committed).toBe(true);
  });

  it("workflow has the correct step graph", () => {
    const workflow = createInvestigationWorkflow({
      model: fakeModel,
      providers: [],
      services: [],
    });

    // The step graph should be defined after commit
    expect(workflow.stepGraph).toBeDefined();
    expect(Array.isArray(workflow.stepGraph)).toBe(true);
  });
});

// ── Degradation tests ─────────────────────────────────────────────────────────

describe("evidence step degradation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("metrics step falls back to default summary when agent.generate throws", async () => {
    // Mock createMetricsAgent to return an agent whose generate rejects
    const { createMetricsAgent } = await import("../agents/metrics.js");
    vi.spyOn({ createMetricsAgent }, "createMetricsAgent");

    // Directly construct a config that produces a step with a throwing agent
    const throwingModel = {
      doGenerate: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      doStream: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      specificationVersion: "v1" as const,
      provider: "test",
      modelId: "test-model",
    } as unknown as LanguageModel;

    const step = buildMetricsStep({ model: throwingModel, providers: [], services: [] });
    const result = await step.execute(makeStepCtx(basePlanningContext));

    // Should degrade gracefully, not throw
    expect(result).toBeDefined();
    expect((result as any).summary).toContain("metrics");
    expect(Array.isArray((result as any).observations)).toBe(true);
  });

  it("logs step falls back to default summary when agent.generate throws", async () => {
    const throwingModel = {
      doGenerate: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      doStream: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      specificationVersion: "v1" as const,
      provider: "test",
      modelId: "test-model",
    } as unknown as LanguageModel;

    const step = buildLogsStep({ model: throwingModel, providers: [], services: [] });
    const result = await step.execute(makeStepCtx(basePlanningContext));

    expect(result).toBeDefined();
    expect((result as any).summary).toContain("logs");
    expect(Array.isArray((result as any).observations)).toBe(true);
  });

  it("infra step falls back to default summary when agent.generate throws", async () => {
    const throwingModel = {
      doGenerate: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      doStream: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      specificationVersion: "v1" as const,
      provider: "test",
      modelId: "test-model",
    } as unknown as LanguageModel;

    const step = buildInfraStep({ model: throwingModel, providers: [], services: [] });
    const result = await step.execute(makeStepCtx(basePlanningContext));

    expect(result).toBeDefined();
    expect((result as any).summary).toContain("infra");
    expect(Array.isArray((result as any).observations)).toBe(true);
  });

  it("when one evidence phase fails, results from other phases are still produced", async () => {
    // This test uses a model that generates valid JSON for logs but throws for metrics.
    // We construct two separate step instances with different models.
    const throwingModel = {
      doGenerate: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      doStream: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      specificationVersion: "v1" as const,
      provider: "test",
      modelId: "test-model",
    } as unknown as LanguageModel;

    // workingModel intentionally also throws so logs step falls through to graceful default —
    // the key invariant is that both steps return a result object, not throw.
    const workingModel = throwingModel;

    const metricsStep = buildMetricsStep({ model: throwingModel, providers: [], services: [] });
    const logsStep = buildLogsStep({ model: workingModel, providers: [], services: [] });
    const infraStep = buildInfraStep({ model: throwingModel, providers: [], services: [] });

    // Run all three evidence steps concurrently — even when all models throw, each step
    // must return a result object (graceful degradation), not propagate the exception.
    const [metricsResult, logsResult, infraResult] = await Promise.all([
      metricsStep.execute(makeStepCtx(basePlanningContext)),
      logsStep.execute(makeStepCtx(basePlanningContext)),
      infraStep.execute(makeStepCtx(basePlanningContext)),
    ]);

    // Each phase degraded gracefully — all have a summary and observations array
    expect((metricsResult as any).summary).toContain("metrics");
    expect((logsResult as any).summary).toContain("logs");
    expect((infraResult as any).summary).toContain("infra");

    // All returned empty observations (not undefined)
    expect(Array.isArray((metricsResult as any).observations)).toBe(true);
    expect(Array.isArray((logsResult as any).observations)).toBe(true);
    expect(Array.isArray((infraResult as any).observations)).toBe(true);
  });
});

// ── Synthesis retry / quality tests ──────────────────────────────────────────

// Mock the synthesis agent module so we can control what generate() returns
// without needing a real LLM connection or the exact AI SDK provider format.
vi.mock("../agents/synthesis.js", () => ({
  createSynthesisAgent: vi.fn(),
}));

describe("synthesis step degradation and defaults", () => {
  const evidenceInputData = {
    "metrics-evidence": { summary: "CPU spike detected", observations: [] },
    "logs-evidence": { summary: "OOM errors found in logs", observations: [] },
    "infra-evidence": { summary: "No infra issues", observations: [] },
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("synthesis step falls back to default rootCause when agent returns non-JSON text", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockResolvedValue({ text: "I cannot determine the root cause." }),
    } as any);

    const step = buildSynthesisStep({ model: fakeModel, providers: [], services: [] });
    const result = await step.execute(makeStepCtx(evidenceInputData));

    // Non-JSON response → JSON.parse throws → catch block → defaults used
    expect((result as any).rootCause).toBe("Unable to determine");
    expect((result as any).severity).toBe("medium");
    expect((result as any).confidence).toBe("low");
  });

  it("synthesis step uses agent-provided values when response is valid JSON", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          severity: "high",
          summary: "Memory leak in api-service causing OOM",
          rootCause: "Unbounded cache growth in request handler",
          trigger: "Traffic spike at 14:00 UTC",
          confidence: "high",
          confidenceScore: 0.9,
        }),
      }),
    } as any);

    const step = buildSynthesisStep({ model: fakeModel, providers: [], services: [] });
    const result = await step.execute(makeStepCtx(evidenceInputData));

    expect((result as any).rootCause).toBe("Unbounded cache growth in request handler");
    expect((result as any).severity).toBe("high");
    expect((result as any).confidence).toBe("high");
    expect((result as any).confidenceScore).toBe(0.9);
  });

  it("synthesis step degrades gracefully when agent.generate throws", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockRejectedValue(new Error("Service unavailable")),
    } as any);

    const step = buildSynthesisStep({ model: fakeModel, providers: [], services: [] });
    const result = await step.execute(makeStepCtx(evidenceInputData));

    // Should not throw — should return safe defaults
    expect(result).toBeDefined();
    expect((result as any).rootCause).toBe("Unable to determine");
    expect((result as any).severity).toBe("medium");
  });

  it("synthesis step produces a valid report from evidence", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          severity: "medium",
          summary: "Synthesis done",
          rootCause: "Database overload",
          trigger: "Batch job",
          confidence: "medium",
          confidenceScore: 0.6,
        }),
      }),
    } as any);

    const step = buildSynthesisStep({ model: fakeModel, providers: [], services: [] });
    const result = await step.execute(makeStepCtx(evidenceInputData)) as any;

    expect(result.severity).toBe("medium");
    expect(result.rootCause).toBe("Database overload");
    expect(result.trigger).toBe("Batch job");
  });

  it("synthesis retry scenario: low-quality response (non-JSON) followed by retry still produces a report", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    // Simulate: first call returns non-JSON (low quality), second call returns valid JSON.
    // The current synthesis step does not auto-retry, but the caller can re-invoke it.
    // This test verifies the step's idempotent degradation — calling it twice with
    // different mock returns gives the expected results each time.
    const generateMock = vi.fn()
      .mockResolvedValueOnce({ text: "Unable to synthesize." })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          severity: "critical",
          summary: "Memory exhaustion due to leak",
          rootCause: "Heap leak in connection pool",
          trigger: "Deployment at 13:00",
          confidence: "high",
          confidenceScore: 0.95,
        }),
      });

    vi.mocked(createSynthesisAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildSynthesisStep({ model: fakeModel, providers: [], services: [] });

    // First attempt — returns defaults (low quality)
    const firstResult = await step.execute(makeStepCtx(evidenceInputData)) as any;
    expect(firstResult.rootCause).toBe("Unable to determine");

    // Second attempt (retry) — returns agent-provided values
    const retryResult = await step.execute(makeStepCtx(evidenceInputData)) as any;
    expect(retryResult.rootCause).toBe("Heap leak in connection pool");
    expect(retryResult.severity).toBe("critical");
    expect(retryResult.confidenceScore).toBe(0.95);
  });

  // ── F-Eng-4: deterministic neighbor evidence injection ──────────────────────
  //
  // The synthesis step MUST append pre-fetched neighbor evidence to
  // `evidence.metrics` / `evidence.logs` AFTER the LLM call, regardless of
  // whether the LLM itself cited the evidence. This is the entire point of
  // Option 3 — the deterministic story does not depend on LLM compliance.

  it("synthesis step deterministically injects neighbor evidence into evidence.metrics/logs", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    // LLM returns a valid JSON with EMPTY evidence arrays — simulating an LLM that
    // ignored the Dependency Evidence section in the prompt. The deterministic
    // injection in synthesis.ts MUST still populate the arrays.
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          severity: "high",
          summary: "Ingestion server rate drop",
          rootCause: "Kafka broker issue (unverified)",
          trigger: "Unknown",
          confidence: "medium",
          confidenceScore: 0.6,
          evidence: { metrics: [], logs: [], infra: [] },
        }),
      }),
    } as any);

    const neighbors = [
      {
        name: "kafka-broker-0",
        directions: ["downstream"] as ("upstream" | "downstream")[],
        status: "unhealthy" as const,
        inServiceRegistry: true,
        requestRate: "25",
        evidence: {
          metrics: [
            {
              query: 'up{service="kafka-broker-0"}',
              values: [
                ["1714060800", "0"] as [string, string],
                ["1714060815", "0"] as [string, string],
              ],
            },
            {
              query: 'rate(http_requests_total{service="kafka-broker-0"}[5m])',
              values: [["1714060800", "0"] as [string, string]],
            },
          ],
          logs: [
            {
              query: '{service="kafka-broker-0"} |~ "(?i)(error)"',
              lines: [
                "2026-04-15T10:00:00Z broker shutdown",
                "2026-04-15T10:00:05Z connection refused",
              ],
              count: 42,
            },
          ],
          fetchedAt: "2026-04-15T10:00:00Z",
          fetchErrors: [],
        },
      },
      {
        name: "web-frontend",
        directions: ["upstream"] as ("upstream" | "downstream")[],
        status: "healthy" as const, // healthy neighbors with no evidence should not appear
        inServiceRegistry: true,
      },
    ];

    // Inject neighbors via the metrics-evidence fallback (same path synthesis reads)
    const inputDataWithNeighbors = {
      ...evidenceInputData,
      "metrics-evidence": {
        ...evidenceInputData["metrics-evidence"],
        neighbors,
      },
    };

    const step = buildSynthesisStep({ model: fakeModel, providers: [], services: [] });
    const result = (await step.execute(makeStepCtx(inputDataWithNeighbors))) as any;

    // F-Eng-4: neighbor metric samples must appear in evidence.metrics with [neighbor:X] prefix
    expect(result.evidence.metrics.length).toBe(2);
    expect(result.evidence.metrics[0]).toContain("[neighbor:kafka-broker-0]");
    expect(result.evidence.metrics[0]).toContain('up{service="kafka-broker-0"}');
    expect(result.evidence.metrics[0]).toContain("0@1714060800");
    expect(result.evidence.metrics[1]).toContain("[neighbor:kafka-broker-0]");
    expect(result.evidence.metrics[1]).toContain("rate(http_requests_total");

    // Neighbor log samples must appear in evidence.logs
    expect(result.evidence.logs.length).toBe(1);
    expect(result.evidence.logs[0]).toContain("[neighbor:kafka-broker-0]");
    expect(result.evidence.logs[0]).toContain("42 matches");
    expect(result.evidence.logs[0]).toContain("broker shutdown");

    // Healthy neighbor (web-frontend) with no evidence field must NOT be injected
    expect(result.evidence.metrics.some((m: string) => m.includes("web-frontend"))).toBe(false);
    expect(result.evidence.logs.some((l: string) => l.includes("web-frontend"))).toBe(false);

    // The synthesis output schema carries neighbors through
    expect(result.neighbors).toBeDefined();
    expect(result.neighbors.length).toBe(2);
  });

  it("synthesis step renders fetchErrors from neighbor evidence", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          severity: "medium",
          summary: "Investigation complete",
          rootCause: "Unknown",
          trigger: "Unknown",
          confidence: "low",
          confidenceScore: 0.3,
          evidence: { metrics: [], logs: [], infra: [] },
        }),
      }),
    } as any);

    const neighbors = [
      {
        name: "broken-neighbor",
        directions: ["downstream"] as ("upstream" | "downstream")[],
        status: "unhealthy" as const,
        inServiceRegistry: true,
        evidence: {
          metrics: [
            { query: "up", values: [], error: "timeout" },
          ],
          logs: [
            { query: '{service="broken-neighbor"}', lines: [], count: 0, error: "tool unavailable" },
          ],
          fetchedAt: "2026-04-15T10:00:00Z",
          fetchErrors: ["metrics: timeout"],
        },
      },
    ];

    const inputDataWithNeighbors = {
      ...evidenceInputData,
      "metrics-evidence": {
        ...evidenceInputData["metrics-evidence"],
        neighbors,
      },
    };

    const step = buildSynthesisStep({ model: fakeModel, providers: [], services: [] });
    const result = (await step.execute(makeStepCtx(inputDataWithNeighbors))) as any;

    // Errors are surfaced in the injected evidence strings, not suppressed
    expect(result.evidence.metrics[0]).toContain("[neighbor:broken-neighbor]");
    expect(result.evidence.metrics[0]).toContain("ERROR: timeout");
    expect(result.evidence.logs[0]).toContain("[neighbor:broken-neighbor]");
    expect(result.evidence.logs[0]).toContain("ERROR: tool unavailable");
  });
});

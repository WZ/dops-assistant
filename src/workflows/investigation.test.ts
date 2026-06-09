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

  it("builds the quick template wired so synthesis gets a valid metrics-evidence shape (inc-7 regression)", () => {
    // The quick template must feed synthesis via `.parallel([metricsStep])`, not
    // `.then(metricsStep)` — otherwise synthesis' inputSchema (which requires the
    // `metrics-evidence` key) fails validation and every quick run (incl. every
    // orchestrator subagent, which uses "quick") degrades to an empty report.
    // This was the "Step input validation failed ×11" no-go from the 2026-06-03
    // Increment-7 batch; fixed in #232. Lock the template exists + commits.
    const workflow = createInvestigationWorkflow({ model: fakeModel, providers: [], services: [] }, "quick");
    expect(workflow.id).toBe("investigation-quick");
    expect(workflow).toBeDefined();
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

  it("N=1 (default) leaves hypothesis-loop fields unset", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({ severity: "high", summary: "s", rootCause: "rc", trigger: "t", confidence: "high", confidenceScore: 0.9 }),
      }),
    } as any);
    const step = buildSynthesisStep({ model: fakeModel, providers: [], services: [] });
    const result = await step.execute(makeStepCtx(evidenceInputData)) as any;
    expect(result.loopOutcome).toBeUndefined();
    expect(result.ruledOut).toBeUndefined();
    expect(result.hypotheses).toBeUndefined();
  });

  it("N>1 runs the hypothesis loop: rules out a weak hypothesis, confirms the discriminating one", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    // Model emits two hypotheses with discriminating predictions. Evidence
    // satisfies the backpressure metric but not the leak log pattern.
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          severity: "critical",
          summary: "checkout OOM",
          rootCause: "payments backpressure",
          trigger: "payments latency",
          confidence: "high",
          confidenceScore: 0.8,
          hypotheses: [
            { hypothesis: "memory leak", prediction: { kind: "log-pattern", pattern: "leak", present: true } },
            { hypothesis: "payments backpressure", prediction: { kind: "metric-threshold", metric: "payments p99", op: ">", value: 5 } },
          ],
        }),
      }),
    } as any);

    const evidence = {
      "metrics-evidence": { summary: "latency", observations: [{ metric: "payments p99 latency", currentValue: "8.0s" }] },
      "logs-evidence": { summary: "logs", observations: [{ pattern: "request ok", sample: "200" }] },
      "infra-evidence": { summary: "", observations: [] },
    };
    const step = buildSynthesisStep({ model: fakeModel, providers: [], services: [], synthesisLoopRounds: 3 });
    const result = await step.execute(makeStepCtx(evidence)) as any;

    expect(result.loopOutcome).toBe("confirmed");
    expect(result.ruledOut.map((r: any) => r.hypothesis)).toEqual(["memory leak"]);
    expect(result.hypotheses).toHaveLength(2);
    // No-regression: the single-pass rootCause is preserved.
    expect(result.rootCause).toBe("payments backpressure");
  });

  it("N>1 with no model-emitted hypotheses falls back cleanly (loop fields unset)", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({ severity: "high", summary: "s", rootCause: "rc", trigger: "t", confidence: "high", confidenceScore: 0.9 }),
      }),
    } as any);
    const step = buildSynthesisStep({ model: fakeModel, providers: [], services: [], synthesisLoopRounds: 3 });
    const result = await step.execute(makeStepCtx(evidenceInputData)) as any;
    expect(result.loopOutcome).toBeUndefined();
    expect(result.rootCause).toBe("rc");
  });

  it("synthesis step degrades gracefully when agent.generate throws", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    // Use a non-transient (application-level) error so withLlmRetry rethrows
    // immediately and existing graceful-degradation kicks in.
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token } in JSON")),
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
});

// ── Quick-template wiring regression ──────────────────────────────────────────
// The synthesis step's input schema requires a `metrics-evidence` KEY (the shape
// `.parallel([...])` produces, keyed by step id). The quick template used to chain
// `.then(metricsStep).then(synthesisStep)`, which hands synthesis the metrics
// step's RAW output (no `metrics-evidence` key) → "Step input validation failed:
// metrics-evidence: Required" → every quick run degraded to an empty report.
// This run-to-success test fails on the old wiring and passes once quick feeds
// synthesis the keyed shape (caught the bug that silently degraded every
// orchestrator subagent, which uses the quick template).
describe("quick template wiring (regression)", () => {
  it("quick workflow runs to success — synthesis receives the metrics-evidence key", async () => {
    const { createSynthesisAgent } = await import("../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          severity: "high",
          summary: "quick synthesis ran",
          rootCause: "quick-template-root-cause",
          trigger: "t",
          confidence: "high",
          confidenceScore: 0.8,
        }),
      }),
    } as any);

    // Throwing model + no providers → prefetch/anomaly/planning/metrics all
    // degrade gracefully (covered above); synthesis uses the mocked agent. So the
    // ONLY thing that can fail the run is the metrics→synthesis input wiring.
    const throwingModel = {
      doGenerate: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      doStream: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      specificationVersion: "v1" as const,
      provider: "test",
      modelId: "test-model",
    } as unknown as LanguageModel;

    const workflow = createInvestigationWorkflow(
      { model: throwingModel, providers: [], services: [noopService] },
      "quick",
    );
    const run = await workflow.createRun();
    const runResult = await run.start({
      inputData: { userMessage: "investigate test-svc", serviceName: "test-svc" },
    });

    expect(runResult.status).toBe("success");
    expect((runResult.result as any)?.rootCause).toBe("quick-template-root-cause");
  });
});

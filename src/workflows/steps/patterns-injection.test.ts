import { describe, it, expect, vi, afterEach } from "vitest";
import type { LanguageModel } from "ai";
import { buildPlanningStep } from "./planning.js";
import { buildSynthesisStep } from "./synthesis.js";
import type { IncidentPatternRow } from "../../agents/shared/patterns.js";

// Mock both agents so we capture the prompt text passed to .generate()
vi.mock("../../agents/planner.js", () => ({
  createPlannerAgent: vi.fn(),
}));
vi.mock("../../agents/synthesis.js", () => ({
  createSynthesisAgent: vi.fn(),
}));

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

const examplePattern: IncidentPatternRow = {
  id: "pat_01XYZ",
  service: "payments-api",
  symptom: "5xx error rate spiked at 12:00 UTC, lasted 11 min.",
  root_cause: "Upstream payments-worker OOMKilled; no circuit breaker.",
  severity: "high",
  recommended_actions: "Add HPA min replicas; add circuit breaker",
  created_at: "2026-04-21T10:00:00.000Z",
};

const planningInput = {
  isAnomaly: true,
  severity: "high" as const,
  summary: "Error rate elevated on payments-api",
  affectedServices: ["payments-api"],
  prefetchContext: {
    datasourceHints: "",
    dashboardContext: "",
    panelQueryHints: "",
    logLabelHints: "",
    workingLogSelectors: [],
  },
  userMessage: "investigate payments-api errors",
  serviceName: "payments-api",
};

const synthesisInput = {
  "metrics-evidence": { summary: "5xx rate spiked", observations: [] },
  "logs-evidence": { summary: "OOM lines", observations: [] },
  "infra-evidence": { summary: "no infra issues", observations: [] },
};

afterEach(() => vi.clearAllMocks());

describe("planning step — learned pattern injection", () => {
  it("threads formatted patterns into the planner prompt when getSimilarPatterns returns rows", async () => {
    const generateMock = vi.fn().mockResolvedValue({ text: "{}" });
    const { createPlannerAgent } = await import("../../agents/planner.js");
    vi.mocked(createPlannerAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildPlanningStep({
      model: fakeModel,
      providers: [],
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
      getSimilarPatterns: () => [examplePattern],
    });
    await step.execute(makeStepCtx(planningInput));

    expect(generateMock).toHaveBeenCalledOnce();
    const prompt = generateMock.mock.calls[0]![0] as string;
    expect(prompt).toContain("Past useful patterns for payments-api:");
    expect(prompt).toContain("[pat_01XYZ — high severity, 2026-04-21]");
    expect(prompt).toContain("Upstream payments-worker OOMKilled");
    expect(prompt).toContain("Use these as priors");
  });

  it("omits the pattern block when getSimilarPatterns returns empty", async () => {
    const generateMock = vi.fn().mockResolvedValue({ text: "{}" });
    const { createPlannerAgent } = await import("../../agents/planner.js");
    vi.mocked(createPlannerAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildPlanningStep({
      model: fakeModel,
      providers: [],
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
      getSimilarPatterns: () => [],
    });
    await step.execute(makeStepCtx(planningInput));

    const prompt = generateMock.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("Past useful patterns for");
    expect(prompt).not.toContain("Use these as priors");
  });

  it("does not crash when getSimilarPatterns is undefined (CLI / test paths)", async () => {
    const generateMock = vi.fn().mockResolvedValue({ text: "{}" });
    const { createPlannerAgent } = await import("../../agents/planner.js");
    vi.mocked(createPlannerAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildPlanningStep({
      model: fakeModel,
      providers: [],
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
    });
    await step.execute(makeStepCtx(planningInput));

    const prompt = generateMock.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("Past useful patterns for");
  });

  it("degrades gracefully when getSimilarPatterns throws", async () => {
    const generateMock = vi.fn().mockResolvedValue({ text: "{}" });
    const { createPlannerAgent } = await import("../../agents/planner.js");
    vi.mocked(createPlannerAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildPlanningStep({
      model: fakeModel,
      providers: [],
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
      getSimilarPatterns: () => { throw new Error("DB unavailable"); },
    });
    await expect(step.execute(makeStepCtx(planningInput))).resolves.toBeDefined();
    const prompt = generateMock.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("Past useful patterns for");
  });
});

describe("synthesis step — learned pattern injection", () => {
  it("threads patterns + calibration instruction into the synthesis prompt for services[0]", async () => {
    const generateMock = vi.fn().mockResolvedValue({ text: "{}" });
    const { createSynthesisAgent } = await import("../../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildSynthesisStep({
      model: fakeModel,
      providers: [],
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
      getSimilarPatterns: () => [examplePattern],
    });
    await step.execute(makeStepCtx(synthesisInput));

    expect(generateMock).toHaveBeenCalledOnce();
    const prompt = generateMock.mock.calls[0]![0] as string;
    expect(prompt).toContain("Past useful patterns for payments-api:");
    expect(prompt).toContain("[pat_01XYZ — high severity, 2026-04-21]");
    expect(prompt).toContain("name the pattern id explicitly");
    expect(prompt).toContain("bump confidence by one tier");
  });

  it("omits patterns when services[0] is missing", async () => {
    const generateMock = vi.fn().mockResolvedValue({ text: "{}" });
    const { createSynthesisAgent } = await import("../../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({ generate: generateMock } as any);

    const getSimilarPatterns = vi.fn().mockReturnValue([examplePattern]);
    const step = buildSynthesisStep({
      model: fakeModel,
      providers: [],
      services: [],
      getSimilarPatterns,
    });
    await step.execute(makeStepCtx(synthesisInput));

    expect(getSimilarPatterns).not.toHaveBeenCalled();
    const prompt = generateMock.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("Past useful patterns for");
  });

  it("does not crash when getSimilarPatterns is undefined", async () => {
    const generateMock = vi.fn().mockResolvedValue({ text: "{}" });
    const { createSynthesisAgent } = await import("../../agents/synthesis.js");
    vi.mocked(createSynthesisAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildSynthesisStep({
      model: fakeModel,
      providers: [],
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
    });
    await expect(step.execute(makeStepCtx(synthesisInput))).resolves.toBeDefined();
  });
});

describe("planning step — malformed planner focus fields (gpt-oss non-array)", () => {
  it("coerces non-array focus fields to [] instead of crashing on .map", async () => {
    // gpt-oss intermittently emits a focus field as a bare string instead of an
    // array; safeJsonParse returns it un-validated, so the later `.map` used to
    // throw and kill the planning step (seen live crashing follow-cause sub-investigations).
    const generateMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        hypotheses: [{ hypothesis: "h", evidenceNeeded: "e" }],
        metricFocus: ["cpu"],
        logFocus: "errors",          // string, not array
        infraFocus: "node health",   // string, not array → the crash
      }),
    });
    const { createPlannerAgent } = await import("../../agents/planner.js");
    vi.mocked(createPlannerAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildPlanningStep({
      model: fakeModel,
      providers: [],
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
    });
    const result = await step.execute(makeStepCtx(planningInput));
    expect(result.infraFocus).toEqual([]);     // coerced, not crashed
    expect(result.logFocus).toEqual([]);
    expect(result.metricFocus).toEqual(["cpu"]); // valid array preserved
    expect(result.hypotheses).toHaveLength(1);
  });

  it("coerces a non-array hypotheses field to [] (the other .map site)", async () => {
    const generateMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({ hypotheses: "not an array", metricFocus: [], logFocus: [], infraFocus: [] }),
    });
    const { createPlannerAgent } = await import("../../agents/planner.js");
    vi.mocked(createPlannerAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildPlanningStep({
      model: fakeModel,
      providers: [],
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
    });
    const result = await step.execute(makeStepCtx(planningInput));
    expect(result.hypotheses).toEqual([]);
  });

  it("filters malformed hypothesis array entries before emitting progress", async () => {
    const onIteration = vi.fn();
    const generateMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        hypotheses: [
          null,
          { hypothesis: "valid", evidenceNeeded: "what to check" },
          { hypothesis: "missing evidence" },
          "not an object",
        ],
        metricFocus: [],
        logFocus: [],
        infraFocus: [],
      }),
    });
    const { createPlannerAgent } = await import("../../agents/planner.js");
    vi.mocked(createPlannerAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildPlanningStep({
      model: fakeModel,
      providers: [],
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
      onIteration,
    });
    const result = await step.execute(makeStepCtx(planningInput));
    expect(result.hypotheses).toEqual([{ hypothesis: "valid", evidenceNeeded: "what to check" }]);
    expect(onIteration).toHaveBeenCalledWith("planning", 0, 1, "Hypotheses: valid → what to check");
  });

  it("filters non-string focus array entries", async () => {
    const generateMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        hypotheses: [],
        metricFocus: ["cpu", null, { query: "up" }, 42],
        logFocus: [false, "timeout"],
        infraFocus: [{ check: "node" }, "node health"],
      }),
    });
    const { createPlannerAgent } = await import("../../agents/planner.js");
    vi.mocked(createPlannerAgent).mockReturnValue({ generate: generateMock } as any);

    const step = buildPlanningStep({
      model: fakeModel,
      providers: [],
      services: [{ name: "payments-api", metrics: [], logLabels: {} }],
    });
    const result = await step.execute(makeStepCtx(planningInput));
    expect(result.metricFocus).toEqual(["cpu"]);
    expect(result.logFocus).toEqual(["timeout"]);
    expect(result.infraFocus).toEqual(["node health"]);
  });
});

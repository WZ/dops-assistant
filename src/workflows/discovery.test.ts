import { describe, it, expect, vi, afterEach } from "vitest";
import { runDiscovery } from "./discovery.js";
import type { DiscoveryWorkflowConfig } from "./discovery.js";
import type { LanguageModel } from "ai";

vi.mock("../mcp/provider.js", () => ({
  getAllTools: vi.fn().mockResolvedValue({ grafana_query_prometheus: {} }),
  getToolsByRole: vi.fn().mockResolvedValue({ grafana_query_prometheus: {} }),
  listProviderTools: vi.fn().mockResolvedValue({}),
}));

// AP2: controllable validate-step throw so we can exercise the terminal-emit
// fallback. When `mockValidateThrows` is true, the wrapper throws before
// delegating; otherwise the real runValidateStep runs so existing tests see
// its actual behavior (unverified services under zero-provider conditions).
let mockValidateThrows = false;
vi.mock("./steps/validate.js", async () => {
  const actual = await vi.importActual<typeof import("./steps/validate.js")>("./steps/validate.js");
  return {
    ...actual,
    runValidateStep: vi.fn(async (config: Parameters<typeof actual.runValidateStep>[0]) => {
      if (mockValidateThrows) throw new Error("validation stalled mid-flow");
      return actual.runValidateStep(config);
    }),
  };
});

// Switches used by individual tests to force the discover agent's output.
let mockDiscoverReturnsEmpty = false;
let mockDiscoverReturnsObjectForm = false;
// Escape hatch for adversarial-fix tests: when non-null, the mock returns
// this string verbatim instead of the default shape. Takes precedence over
// the two switches above.
let mockDiscoverReplyOverride: string | null = null;

// Captures the most recent options passed to the discover agent's generate()
// call, so abortSignal-plumbing tests can introspect it.
const lastDiscoverGenerateOpts: { value: any } = { value: undefined };
let mockDiscoverTimeoutFirstGenerate = false;
const discoverGenerateSignals: AbortSignal[] = [];
const discoverGenerateSignalStates: Array<{ sameAsFirst: boolean; abortedOnEntry: boolean }> = [];

// Stall-recovery test plumbing. When `mockDiscoverStallThenRecover` is true,
// the FIRST discover.generate() call returns empty text (the stall failure
// mode); the SECOND returns parseable JSON (the recovery turn invoked by
// runDiscoverStep). Each call also records its options so the test can
// assert toolChoice: "none" on the recovery turn.
let mockDiscoverStallThenRecover = false;
const discoverGenerateCalls: Array<{ promptType: "primary" | "recovery"; opts: any }> = [];

vi.mock("@mastra/core/agent", () => ({
  Agent: class MockAgent {
    id: string;
    name: string;
    constructor(opts: any) { this.id = opts.id; this.name = opts.name; }
    async generate(prompt: string, opts?: any) {
      if (this.id === "discover") {
        lastDiscoverGenerateOpts.value = opts;
        if (mockDiscoverStallThenRecover) {
          // Recovery prompt is recognizable by its leading sentence — the
          // primary prompt is the bare "Discover all monitored services..."
          // sentence the production code passes to agent.generate().
          const isRecovery = prompt.startsWith("You previously made");
          discoverGenerateCalls.push({ promptType: isRecovery ? "recovery" : "primary", opts });
          if (!isRecovery) {
            // Simulate a tool call via onStepFinish so recoveryToolHistory
            // populates — the recovery path requires non-empty history to
            // fire.
            opts?.onStepFinish?.({
              toolResults: [{
                toolName: "fake_tool",
                args: { q: "x" },
                result: { content: [{ text: '{"data":[{"metric":{"deployment":"svc-a"}}]}' }] },
              }],
            });
            return { text: "" };
          }
          return {
            text: JSON.stringify({
              services: [
                { name: "recovered-svc", metrics: [{ query: 'up{a="1"}', description: "" }], logLabels: {} },
              ],
              globalProbeRules: [],
            }),
          };
        }
        if (mockDiscoverTimeoutFirstGenerate) {
          const signal = opts?.abortSignal as AbortSignal | undefined;
          if (signal) {
            discoverGenerateSignalStates.push({
              sameAsFirst: signal === discoverGenerateSignals[0],
              abortedOnEntry: signal.aborted,
            });
            discoverGenerateSignals.push(signal);
          }
          if (discoverGenerateSignals.length === 1 && signal) {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            throw signal.reason;
          }
        }
        if (mockDiscoverReplyOverride !== null) return { text: mockDiscoverReplyOverride };
        if (mockDiscoverReturnsEmpty) return { text: "[]" };
        if (mockDiscoverReturnsObjectForm) {
          // Slice B output shape: top-level {services, globalProbeRules}.
          return { text: JSON.stringify({
            services: [{ name: "svc1", metrics: [{ query: "up{}", description: "" }], logLabels: {} }],
            globalProbeRules: [
              { name: "app_availability", query: 'up{app="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 3, source: "metrics" },
            ],
          }) };
        }
        return { text: JSON.stringify([{ name: "svc1", metrics: [{ query: "up{}", description: "" }], logLabels: {} }]) };
      }
      if (this.id === "discover-validator") {
        return { text: JSON.stringify([{ name: "svc1", metrics: [{ query: "up{}", description: "" }], logLabels: {}, confidence: "verified", validationNotes: "metrics \u2713" }]) };
      }
      return { text: "[]" };
    }
  },
}));

const fakeModel = {} as LanguageModel;

describe("runDiscovery", () => {

  it("returns validated services and empty globalProbeRules from bare-array agent output", async () => {
    const config: DiscoveryWorkflowConfig = {
      model: fakeModel,
      providers: [],
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5, discoveryRecipes: [] },
    };
    const result = await runDiscovery(config);
    expect(result.services).toHaveLength(1);
    expect(result.services[0]!.name).toBe("svc1");
    // With no MCP providers, deterministic validation can't find tools to verify
    expect(result.services[0]!.confidence).toBe("unverified");
    // Backward-compat path: agent returned a bare array, no globals written.
    expect(result.globalProbeRules).toEqual([]);
  });

  it("calls onPhase callbacks and emits a terminal 'complete' phase on success", async () => {
    const phases: string[] = [];
    const config: DiscoveryWorkflowConfig = {
      model: fakeModel,
      providers: [],
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5, discoveryRecipes: [] },
      onPhase: (phase) => phases.push(phase),
    };
    await runDiscovery(config);
    expect(phases).toContain("discovery");
    expect(phases).toContain("validation");
    // AP2: terminal phase always emitted last so the caller gets a clear "done" signal.
    expect(phases[phases.length - 1]).toBe("complete");
  });

  it("emits 'complete-empty' phase and skips validation when discovery returns zero services", async () => {
    mockDiscoverReturnsEmpty = true;
    try {
      const phases: string[] = [];
      const config: DiscoveryWorkflowConfig = {
        model: fakeModel,
        providers: [],
        discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5, discoveryRecipes: [] },
        onPhase: (phase) => phases.push(phase),
      };
      const result = await runDiscovery(config);
      expect(result.services).toEqual([]);
      expect(result.globalProbeRules).toEqual([]);
      expect(phases).toEqual(["discovery", "complete-empty"]);
      expect(phases).not.toContain("validation");
    } finally {
      mockDiscoverReturnsEmpty = false;
    }
  });

  it("AP2: falls back to unverified discovered services and emits terminal phase when validation throws", async () => {
    mockValidateThrows = true;
    try {
      const phases: string[] = [];
      const config: DiscoveryWorkflowConfig = {
        model: fakeModel,
        providers: [],
        discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5, discoveryRecipes: [] },
        onPhase: (phase) => phases.push(phase),
      };
      const result = await runDiscovery(config);
      // Discovered services surface as unverified so services.yaml is still writable.
      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.name).toBe("svc1");
      // Load-bearing tagging — operators reading services.yaml must be able
      // to distinguish fallback output from real validation output.
      expect(result.services[0]!.confidence).toBe("unverified");
      expect(result.services[0]!.validationNotes).toMatch(/validation did not complete/);
      // Terminal phase emitted so the caller knows validation failed but discovery produced data.
      expect(phases).toContain("discovery");
      expect(phases).toContain("validation");
      expect(phases[phases.length - 1]).toBe("complete-validation-failed");
    } finally {
      mockValidateThrows = false;
    }
  });

  it("AP2: emits terminal 'complete-failed' phase when the discover step itself throws", async () => {
    // Force runDiscoverStep to throw by returning an empty tool map. The
    // workflow should still emit a terminal phase via the finally block.
    const { getToolsByRole } = await import("../mcp/provider.js");
    const mocked = vi.mocked(getToolsByRole);
    mocked.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const phases: string[] = [];
    const config: DiscoveryWorkflowConfig = {
      model: fakeModel,
      providers: [],
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5, discoveryRecipes: [] },
      onPhase: (phase) => phases.push(phase),
    };
    await expect(runDiscovery(config)).rejects.toThrow();
    expect(phases[phases.length - 1]).toBe("complete-failed");
  });

  it("carries through globalProbeRules when the agent returns the object form", async () => {
    mockDiscoverReturnsObjectForm = true;
    try {
      const config: DiscoveryWorkflowConfig = {
        model: fakeModel,
        providers: [],
        discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5, discoveryRecipes: [] },
      };
      const result = await runDiscovery(config);
      expect(result.services).toHaveLength(1);
      expect(result.globalProbeRules).toHaveLength(1);
      expect(result.globalProbeRules[0]!.name).toBe("app_availability");
      expect(result.globalProbeRules[0]!.source).toBe("metrics");
    } finally {
      mockDiscoverReturnsObjectForm = false;
    }
  });
});

describe("runDiscoverStep — adversarial-review fixes (2026-04-22)", () => {
  // These tests exercise the fixes applied to runDiscoverStep directly:
  // validateDiscoveredRules drops unsafe rules before they reach the
  // registry, and the empty-services branch preserves globals.
  // Uses the mockDiscoverReplyOverride escape hatch on the existing
  // vi.mock (module-hoisted) rather than a second vi.mock call.

  const baseConfig: DiscoveryWorkflowConfig = {
    model: fakeModel,
    providers: [],
    discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5, discoveryRecipes: [] },
  };

  afterEach(() => {
    mockDiscoverReplyOverride = null;
    mockDiscoverTimeoutFirstGenerate = false;
    discoverGenerateSignals.length = 0;
    discoverGenerateSignalStates.length = 0;
  });

  it("B — accepts object form when globalProbeRules is non-empty even if services is empty", async () => {
    mockDiscoverReplyOverride = JSON.stringify({
      services: [],
      globalProbeRules: [{
        name: "app_availability",
        query: 'up{app="{service}"}',
        threshold: { op: "lt", value: 1 },
        consecutiveTicks: 3,
        source: "metrics",
      }],
    });
    const result = await runDiscovery(baseConfig);
    expect(result.services).toEqual([]);
    expect(result.globalProbeRules).toHaveLength(1);
    expect(result.globalProbeRules[0]!.name).toBe("app_availability");
  });

  it("A — drops LLM-written rules with unsafe names (colon forbidden)", async () => {
    mockDiscoverReplyOverride = JSON.stringify({
      services: [{ name: "svc1", metrics: [{ query: "up{}", description: "" }], logLabels: {} }],
      globalProbeRules: [
        { name: "ok_rule", query: 'up{app="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1, source: "metrics" },
        // State-key corruption: name with ':' would break the scheduler's
        // `lastIndexOf(":")` parse. Must be dropped before persisting.
        { name: "db:slow", query: 'up{app="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1, source: "metrics" },
      ],
    });
    const result = await runDiscovery(baseConfig);
    expect(result.globalProbeRules).toHaveLength(1);
    expect(result.globalProbeRules[0]!.name).toBe("ok_rule");
  });

  it("A — drops LLM-written rules with malformed threshold op", async () => {
    mockDiscoverReplyOverride = JSON.stringify({
      services: [{ name: "svc1", metrics: [{ query: "up{}", description: "" }], logLabels: {} }],
      globalProbeRules: [
        { name: "bad_op", query: 'up{app="{service}"}', threshold: { op: "equals", value: 1 }, consecutiveTicks: 1 },
      ],
    });
    const result = await runDiscovery(baseConfig);
    // Bad-op rule dropped. Services list retained.
    expect(result.globalProbeRules).toEqual([]);
  });

  it("backfills service_availability when the LLM omits it but metrics[0] exists", async () => {
    // Real-world regression: gpt-oss-120b consistently skips the
    // service_availability rule no matter how explicit the prompt gets. The
    // rule is mechanically derivable from metrics[0].query, so
    // validateDiscoveredServices prepends it deterministically.
    mockDiscoverReplyOverride = JSON.stringify({
      services: [
        {
          name: "svc-from-consul",
          metrics: [{ query: 'consul_catalog_service_node_healthy{service_name="svc-from-consul"}', description: "" }],
          logLabels: { container: "svc-from-consul" },
          probeRules: [
            // LLM wrote log_errors but NOT service_availability.
            { name: "log_errors", query: 'sum(count_over_time({container="svc-from-consul"} |= `error` [15m]))', threshold: { op: "gt", value: 75 }, consecutiveTicks: 2, source: "logs" },
          ],
        },
      ],
      globalProbeRules: [],
    });
    const result = await runDiscovery(baseConfig);
    expect(result.services).toHaveLength(1);
    const svc = result.services[0]!;
    const names = (svc.probeRules ?? []).map((r) => r.name);
    expect(names).toContain("service_availability");
    expect(names).toContain("log_errors");
    const availability = (svc.probeRules ?? []).find((r) => r.name === "service_availability")!;
    expect(availability.query).toBe('consul_catalog_service_node_healthy{service_name="svc-from-consul"}');
    expect(availability.threshold).toEqual({ op: "lt", value: 1 });
    expect(availability.consecutiveTicks).toBe(3);
  });

  it("does not backfill service_availability if metrics is empty", async () => {
    mockDiscoverReplyOverride = JSON.stringify({
      services: [
        { name: "no-metrics-service", metrics: [], logLabels: {}, probeRules: [] },
      ],
      globalProbeRules: [],
    });
    const result = await runDiscovery(baseConfig);
    const names = (result.services[0]?.probeRules ?? []).map((r) => r.name);
    expect(names).not.toContain("service_availability");
  });

  it("does not double-backfill when the LLM already wrote service_availability", async () => {
    mockDiscoverReplyOverride = JSON.stringify({
      services: [
        {
          name: "svc",
          metrics: [{ query: 'up{app="svc"}', description: "" }],
          logLabels: {},
          probeRules: [
            { name: "service_availability", query: 'up{app="svc"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 3, source: "metrics" },
          ],
        },
      ],
      globalProbeRules: [],
    });
    const result = await runDiscovery(baseConfig);
    const availRules = (result.services[0]?.probeRules ?? []).filter((r) => r.name === "service_availability");
    expect(availRules).toHaveLength(1);
  });

  it("passes a non-aborted AbortSignal to discover agent.generate when llmCallMs is set", async () => {
    lastDiscoverGenerateOpts.value = undefined;
    await runDiscovery({ ...baseConfig, llmCallMs: 60_000 });
    const opts = lastDiscoverGenerateOpts.value;
    expect(opts).toBeDefined();
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    expect(opts.abortSignal.aborted).toBe(false);
  });

  it("omits abortSignal when llmCallMs is unset", async () => {
    lastDiscoverGenerateOpts.value = undefined;
    await runDiscovery(baseConfig);
    const opts = lastDiscoverGenerateOpts.value;
    expect(opts).toBeDefined();
    expect(opts.abortSignal).toBeUndefined();
  });

  it("uses a fresh AbortSignal for the retry after a timeout", async () => {
    mockDiscoverTimeoutFirstGenerate = true;
    await runDiscovery({
      ...baseConfig,
      llmRetry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, jitterPercent: 0 },
      llmCallMs: 1,
    });

    expect(discoverGenerateSignals).toHaveLength(2);
    expect(discoverGenerateSignals[0]!.aborted).toBe(true);
    expect(discoverGenerateSignalStates[1]).toEqual({
      sameAsFirst: false,
      abortedOnEntry: false,
    });
  });

  // Regression: gpt-oss-120b on saturated context sometimes stops calling
  // tools AND emits 0 chars of synthesis text. The prepareStep wind-down
  // doesn't help (model exits the agent loop before the wind-down step
  // fires), so runDiscoverStep manually invokes a follow-up call with
  // toolChoice: "none" and the captured tool data inline.
  it("invokes a stall-recovery follow-up when the primary attempt returns empty text", async () => {
    mockDiscoverStallThenRecover = true;
    discoverGenerateCalls.length = 0;
    try {
      const result = await runDiscovery(baseConfig);
      // Both calls fired: primary (empty) + recovery (JSON).
      expect(discoverGenerateCalls).toHaveLength(2);
      expect(discoverGenerateCalls[0]!.promptType).toBe("primary");
      expect(discoverGenerateCalls[1]!.promptType).toBe("recovery");
      // Recovery turn must disable tools — that's the whole point of the
      // intervention; the model already decided not to call more tools and
      // we don't want to give it the option to backtrack.
      expect(discoverGenerateCalls[1]!.opts?.toolChoice).toBe("none");
      // Service recovered from the synthetic JSON.
      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.name).toBe("recovered-svc");
    } finally {
      mockDiscoverStallThenRecover = false;
      discoverGenerateCalls.length = 0;
    }
  });

  // Regression: the OpenAI-compatible gateway rejects requests with
  // "max_tokens must be at least 1, got -N" when prompt_tokens plus the
  // requested max_tokens overflow the model's context window. Earlier code
  // hard-coded 32768 here, which overflowed once discovery accumulated
  // enough tool-result history. The cap is now sourced from
  // `discoveryConfig.maxOutputTokens` so operators can tune per stack.
  it("forwards discoveryConfig.maxOutputTokens to the agent's providerOptions", async () => {
    lastDiscoverGenerateOpts.value = undefined;
    await runDiscovery({
      ...baseConfig,
      discoveryConfig: { ...baseConfig.discoveryConfig, maxOutputTokens: 4096 },
    });
    const opts = lastDiscoverGenerateOpts.value;
    expect(opts).toBeDefined();
    expect(opts.providerOptions?.["openai-compatible"]?.max_tokens).toBe(4096);
  });
});

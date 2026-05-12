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
// When true, runValidateStep hangs until config.abortSignal aborts, then
// rethrows the abort reason. Lets us test that abort during validation
// propagates as AbortError instead of being swallowed into "unverified".
let mockValidateHangsForAbort = false;
vi.mock("./steps/validate.js", async () => {
  const actual = await vi.importActual<typeof import("./steps/validate.js")>("./steps/validate.js");
  return {
    ...actual,
    runValidateStep: vi.fn(async (config: Parameters<typeof actual.runValidateStep>[0]) => {
      if (mockValidateThrows) throw new Error("validation stalled mid-flow");
      if (mockValidateHangsForAbort) {
        await new Promise<void>((_resolve, reject) => {
          config.abortSignal?.addEventListener("abort", () => {
            const reason = config.abortSignal!.reason;
            const err = reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
            err.name = "AbortError";
            reject(err);
          });
        });
        return [];
      }
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
let mockDiscoverTimeoutAfterToolData = false;
let mockDiscoverNeverSettles = false;
const discoverGenerateSignals: AbortSignal[] = [];
const discoverGenerateSignalStates: Array<{ sameAsFirst: boolean; abortedOnEntry: boolean }> = [];

vi.mock("@mastra/core/agent", () => ({
  Agent: class MockAgent {
    id: string;
    name: string;
    tools: Record<string, any>;
    constructor(opts: any) { this.id = opts.id; this.name = opts.name; this.tools = opts.tools ?? {}; }
    async generate(prompt: string, opts?: any) {
      if (this.id === "discover") {
        lastDiscoverGenerateOpts.value = opts;
        if (mockDiscoverTimeoutAfterToolData) {
          opts?.onStepFinish?.({
            toolResults: [{
              toolName: "grafana_query_prometheus",
              args: {
                datasourceUid: "prometheus",
                expr: "count by (deployment) (kube_deployment_status_replicas_available)",
                queryType: "instant",
                startTime: "now",
                endTime: "now",
                stepSeconds: 0,
              },
              result: {
                content: [{
                  type: "text",
                  text: '{"data":[{"metric":{"deployment":"svc-timeout","namespace":"apps"},"value":[1,"1"]}]}',
                }],
              },
            }],
          });
          const signal = opts?.abortSignal as AbortSignal | undefined;
          if (signal) {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            throw signal.reason;
          }
        }
        if (mockDiscoverNeverSettles) {
          return new Promise(() => {});
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
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
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
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
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
        discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
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
        discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
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

  it("propagates abort during the validation phase as a terminal 'complete-failed', not as unverified-success", async () => {
    mockValidateHangsForAbort = true;
    try {
      const controller = new AbortController();
      const phases: string[] = [];
      const promise = runDiscovery({
        model: fakeModel,
        providers: [],
        discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
        onPhase: (phase) => phases.push(phase),
        abortSignal: controller.signal,
      });

      // Wait for validation phase to enter the hanging mock
      await new Promise<void>((resolve) => {
        const check = () => {
          if (phases.includes("validation")) resolve();
          else setTimeout(check, 5);
        };
        check();
      });

      controller.abort(new Error("client closed"));

      await expect(promise).rejects.toThrow("client closed");
      // Critical: validation-abort must surface as 'complete-failed', NOT as
      // 'complete-validation-failed' (which would mean we silently returned
      // unverified services and lied about cancellation).
      expect(phases[phases.length - 1]).toBe("complete-failed");
    } finally {
      mockValidateHangsForAbort = false;
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
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
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
        discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
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
    discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
  };

  afterEach(() => {
    mockDiscoverReplyOverride = null;
    mockDiscoverTimeoutFirstGenerate = false;
    mockDiscoverTimeoutAfterToolData = false;
    mockDiscoverNeverSettles = false;
    discoverGenerateSignals.length = 0;
    discoverGenerateSignalStates.length = 0;
    vi.useRealTimers();
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

  // backfill:service-availability / global-availability tests removed in 2026-05
  // alongside the backfill code in src/workflows/steps/discover/parse.ts —
  // 51 stress iters showed 0 fires; the LLM emits availability rules itself.

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

  it("fails fast when the primary discovery LLM times out before tool data is captured", async () => {
    mockDiscoverTimeoutFirstGenerate = true;
    await expect(runDiscovery({
      ...baseConfig,
      llmRetry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, jitterPercent: 0 },
      llmCallMs: 1,
    })).rejects.toThrow("LLM call timed out after 1ms");

    expect(discoverGenerateSignals).toHaveLength(1);
    expect(discoverGenerateSignals[0]!.aborted).toBe(true);
  });

  it("hard-times out when the discover agent ignores the abort signal", async () => {
    vi.useFakeTimers();
    mockDiscoverNeverSettles = true;
    const phases: string[] = [];
    const promise = runDiscovery({
      ...baseConfig,
      llmRetry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitterPercent: 0 },
      llmCallMs: 10,
      onPhase: (phase) => phases.push(phase),
    });
    const assertion = expect(promise).rejects.toThrow("LLM call timed out after 10ms");

    await vi.advanceTimersByTimeAsync(11);

    await assertion;
    expect(phases[phases.length - 1]).toBe("complete-failed");
  });

  it("returns deterministic candidates when the primary discovery LLM times out after tool data", async () => {
    vi.useFakeTimers();
    mockDiscoverTimeoutAfterToolData = true;
    const promise = runDiscovery({
      ...baseConfig,
      llmCallMs: 10,
    });

    await vi.advanceTimersByTimeAsync(11);
    const result = await promise;

    expect(result.services.some((service) => service.name === "svc-timeout")).toBe(true);
  });

  it("aborts from the caller signal even when the discover agent never settles", async () => {
    mockDiscoverNeverSettles = true;
    const controller = new AbortController();
    const phases: string[] = [];
    const promise = runDiscovery({
      ...baseConfig,
      llmRetry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, jitterPercent: 0 },
      llmCallMs: 60_000,
      abortSignal: controller.signal,
      onPhase: (phase) => phases.push(phase),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("client closed"));

    await expect(promise).rejects.toThrow("client closed");
    expect(phases[phases.length - 1]).toBe("complete-failed");
  });

  // stall-recovery tests removed in 2026-05 alongside the recovery code in
  // src/workflows/steps/discover/stall-recovery.ts — 51 stress iters showed
  // 0 fires; the timeout-fallback path + deterministic-merge rescue handle
  // the same failure modes without a second LLM call.

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

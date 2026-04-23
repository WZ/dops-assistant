import { describe, it, expect, vi, afterEach } from "vitest";
import { runDiscovery } from "./discovery.js";
import type { DiscoveryWorkflowConfig } from "./discovery.js";
import type { LanguageModel } from "ai";

vi.mock("../mcp/provider.js", () => ({
  getAllTools: vi.fn().mockResolvedValue({ grafana_query_prometheus: {} }),
  getToolsByRole: vi.fn().mockResolvedValue({ grafana_query_prometheus: {} }),
  listProviderTools: vi.fn().mockResolvedValue({}),
}));

// Switches used by individual tests to force the discover agent's output.
let mockDiscoverReturnsEmpty = false;
let mockDiscoverReturnsObjectForm = false;
// Escape hatch for adversarial-fix tests: when non-null, the mock returns
// this string verbatim instead of the default shape. Takes precedence over
// the two switches above.
let mockDiscoverReplyOverride: string | null = null;

vi.mock("@mastra/core/agent", () => ({
  Agent: class MockAgent {
    id: string;
    name: string;
    constructor(opts: any) { this.id = opts.id; this.name = opts.name; }
    async generate(prompt: string) {
      if (this.id === "discover") {
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

  it("calls onPhase callbacks", async () => {
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
});

import { describe, it, expect, vi } from "vitest";
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

vi.mock("@mastra/core/agent", () => ({
  Agent: class MockAgent {
    id: string;
    name: string;
    constructor(opts: any) { this.id = opts.id; this.name = opts.name; }
    async generate(prompt: string) {
      if (this.id === "discover") {
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

describe("runDiscovery", () => {
  const fakeModel = {} as LanguageModel;

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

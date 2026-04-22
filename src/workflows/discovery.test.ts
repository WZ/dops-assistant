import { describe, it, expect, vi } from "vitest";
import { runDiscovery } from "./discovery.js";
import type { DiscoveryWorkflowConfig } from "./discovery.js";
import type { LanguageModel } from "ai";

vi.mock("../mcp/provider.js", () => ({
  getAllTools: vi.fn().mockResolvedValue({ grafana_query_prometheus: {} }),
  getToolsByRole: vi.fn().mockResolvedValue({ grafana_query_prometheus: {} }),
  listProviderTools: vi.fn().mockResolvedValue({}),
}));

// Switch used by individual tests to force the discover agent to return [].
let mockDiscoverReturnsEmpty = false;

vi.mock("@mastra/core/agent", () => ({
  Agent: class MockAgent {
    id: string;
    name: string;
    constructor(opts: any) { this.id = opts.id; this.name = opts.name; }
    async generate(prompt: string) {
      if (this.id === "discover") {
        if (mockDiscoverReturnsEmpty) return { text: "[]" };
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

  it("returns validated services", async () => {
    const config: DiscoveryWorkflowConfig = {
      model: fakeModel,
      providers: [],
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5, discoveryRecipes: [] },
    };
    const result = await runDiscovery(config);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("svc1");
    // With no MCP providers, deterministic validation can't find tools to verify
    expect(result[0].confidence).toBe("unverified");
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
      expect(result).toEqual([]);
      expect(phases).toEqual(["discovery", "complete-empty"]);
      expect(phases).not.toContain("validation");
    } finally {
      mockDiscoverReturnsEmpty = false;
    }
  });
});

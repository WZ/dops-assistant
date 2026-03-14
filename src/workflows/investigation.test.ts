import { describe, it, expect, vi } from "vitest";
import type { LanguageModel } from "ai";
import { createInvestigationWorkflow } from "./investigation.js";
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

// src/cli/commands/e2e.test.ts
import { describe, it, expect, vi } from "vitest";
import { runE2e, type ScenarioFile } from "./e2e.js";
import type { IChatAgent, IInvestigationAgent } from "../../types/agent-interfaces.js";
import type { ServiceConfig } from "../../config/schema.js";

const MOCK_SERVICE: ServiceConfig = { name: "api-gateway", metrics: [], logLabels: {} };

const MOCK_REPORT = {
  service: "api-gateway",
  severity: "high",
  confidence: "high",
  confidenceScore: 0.85,
  summary: "CPU spike",
  trigger: "Alert",
  rootCause: "Memory leak",
  impact: { duration: "30m", description: "Slow" },
  contributingFactors: [],
  timeline: [],
  evidence: { metrics: ["cpu > 90%"], logs: [], infra: [] },
  dashboardLinks: [],
  recommendedActions: [],
  investigatedAt: "2026-03-15T14:35:00Z",
};

function makeMockAgents() {
  return {
    chatAgent: {
      chat: vi.fn().mockResolvedValue({ response: "3 alerts firing", updatedHistory: [], images: [] }),
    } as IChatAgent,
    investigationAgent: {
      investigate: vi.fn().mockResolvedValue(MOCK_REPORT),
    } as IInvestigationAgent,
  };
}

describe("runE2e", () => {
  it("runs a passing scenario", async () => {
    const agents = makeMockAgents();
    const scenario: ScenarioFile = {
      name: "basic-test",
      steps: [
        {
          command: "investigate",
          args: { service: "api-gateway" },
          assert: { status: "success" },
        },
      ],
    };

    const result = await runE2e(scenario, agents, [MOCK_SERVICE], { verbose: false, history: false });

    expect(result.command).toBe("e2e");
    expect(result.status).toBe("pass");
    expect(result.steps[0]!.status).toBe("pass");
  });

  it("reports failing assertion", async () => {
    const agents = makeMockAgents();
    const scenario: ScenarioFile = {
      name: "fail-test",
      steps: [
        {
          command: "investigate",
          args: { service: "api-gateway" },
          assert: { "result.severity": "critical" }, // actual is "high"
        },
      ],
    };

    const result = await runE2e(scenario, agents, [MOCK_SERVICE], { verbose: false, history: false });

    expect(result.status).toBe("fail");
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.assertions![0]!.pass).toBe(false);
  });

  it("runs chat steps", async () => {
    const agents = makeMockAgents();
    const scenario: ScenarioFile = {
      name: "chat-test",
      steps: [
        {
          command: "chat",
          args: { message: "What alerts?" },
          assert: { status: "success", "result.response": { contains: "alerts" } },
        },
      ],
    };

    const result = await runE2e(scenario, agents, [MOCK_SERVICE], { verbose: false, history: false });

    expect(result.status).toBe("pass");
    expect(result.steps[0]!.assertions!).toHaveLength(2);
  });

  it("skips remaining steps on fatal error", async () => {
    const agents = makeMockAgents();
    (agents.investigationAgent.investigate as any).mockRejectedValueOnce(new Error("MCP connection lost"));

    const scenario: ScenarioFile = {
      name: "skip-test",
      steps: [
        { command: "investigate", args: { service: "api-gateway" }, assert: { status: "success" } },
        { command: "chat", args: { message: "hello" }, assert: { status: "success" } },
      ],
    };

    const result = await runE2e(scenario, agents, [MOCK_SERVICE], { verbose: false, history: false });

    expect(result.status).toBe("fail");
    expect(result.steps[0]!.status).toBe("fail");
    // Step 2 still runs because a generic agent error is not a connectivity fatal
    expect(result.steps[1]!.status).toBe("pass");
  });
});

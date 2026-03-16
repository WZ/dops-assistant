import { describe, it, expect, vi } from "vitest";
import { runInvestigate, resolveService } from "./investigate.js";
import type { IInvestigationAgent } from "../../types/agent-interfaces.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { RcaReport } from "../../types/rca-types.js";

const MOCK_SERVICE: ServiceConfig = {
  name: "api-gateway",
  metrics: [],
  logLabels: {},
};

const MOCK_REPORT: RcaReport = {
  service: "api-gateway",
  severity: "high",
  confidence: "high",
  confidenceScore: 0.85,
  summary: "High CPU usage",
  trigger: "Alert fired",
  rootCause: "Memory leak in handler",
  impact: { duration: "30m", description: "Degraded response times" },
  contributingFactors: ["Increased traffic"],
  timeline: [{ time: "14:30", event: "CPU spike" }],
  evidence: { metrics: ["cpu > 90%"], logs: ["OOM errors"], infra: [] },
  dashboardLinks: [],
  recommendedActions: ["Restart pods"],
  investigatedAt: "2026-03-15T14:35:00Z",
};

describe("resolveService", () => {
  const services = [MOCK_SERVICE, { name: "payment-service", metrics: [], logLabels: {} }];

  it("matches exact service name case-insensitively", () => {
    expect(resolveService("API-Gateway", services)).toEqual(MOCK_SERVICE);
  });

  it("returns undefined for unknown service", () => {
    expect(resolveService("unknown-svc", services)).toBeUndefined();
  });
});

describe("runInvestigate", () => {
  it("returns RCA report on success", async () => {
    const agent: IInvestigationAgent = {
      investigate: vi.fn().mockResolvedValue(MOCK_REPORT),
    };

    const result = await runInvestigate(agent, MOCK_SERVICE, {
      verbose: false,
      history: false,
      userMessage: "investigate api-gateway",
    });

    expect(result.command).toBe("investigate");
    expect(result.service).toBe("api-gateway");
    expect(result.status).toBe("success");
    expect(result.result).toEqual(MOCK_REPORT);
    expect(result.history).toBe(false);
  });

  it("returns error on agent failure", async () => {
    const agent: IInvestigationAgent = {
      investigate: vi.fn().mockRejectedValue(new Error("workflow failed")),
    };

    const result = await runInvestigate(agent, MOCK_SERVICE, {
      verbose: false,
      history: false,
      userMessage: "investigate api-gateway",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("workflow failed");
    expect(result.result).toBeNull();
  });
});

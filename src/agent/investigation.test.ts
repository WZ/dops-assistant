import { describe, it, expect, vi } from "vitest";
import { InvestigationAgent } from "./investigation.js";
import type { LlmClient } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import type { AnomalyAssessment } from "./types.js";

const mockTools = [{ type: "function" as const, function: { name: "query_prometheus", description: "", parameters: {} } }];

const mockMcp = {
  getTools: vi.fn().mockReturnValue(mockTools),
  callTool: vi.fn().mockResolvedValue({ text: "metric data", images: [] }),
  isConnected: vi.fn().mockReturnValue(true),
} as unknown as McpClient;

const baseMetricFindings = JSON.stringify({ observations: ["error_rate: 18%"], baseline: "0.2%", anomalyWindow: "14:32 UTC" });
const baseLogFindings = JSON.stringify({
  errorPatterns: ["connection timeout"],
  stackTraces: [],
  logSamples: ["[14:30:01] ERROR connection timeout to db-primary"],
  lokiSearchTerms: ['{app="payments-api"} |= "connection timeout"'],
  firstOccurrence: "14:30 UTC",
});
const baseInfraFindings = JSON.stringify({ podHealth: ["restarted 3x"], nodeHealth: [], recentEvents: [] });
const baseRcaReport = JSON.stringify({
  severity: "high",
  summary: "High error rate",
  rootCause: "DB connection pool exhausted",
  evidence: { metrics: ["error_rate: 18%"], logs: ["connection timeout"], infra: ["restarted 3x"] },
  recommendedActions: ["Scale connection pool"],
  confidence: "high",
});

const service = { name: "payments-api", metrics: [{ query: 'rate(errors[5m])', description: "error rate" }], logLabels: { app: "payments-api" } };

const anomaly: AnomalyAssessment = {
  isAnomaly: true,
  severity: "high",
  summary: "High error rate",
  affectedMetrics: ["error_rate"],
  recommendedAction: "Investigate",
};

function makeMockLlm(responses: string[]): LlmClient {
  let call = 0;
  return {
    chat: vi.fn().mockImplementation(() =>
      Promise.resolve({ type: "text", content: responses[call++] ?? "{}" })
    ),
  } as unknown as LlmClient;
}

describe("InvestigationAgent", () => {
  it("runs phases 2/3/4 in parallel and synthesises into RcaReport", async () => {
    const llm = makeMockLlm([baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly, "corr-001");

    expect(report.service).toBe("payments-api");
    expect(report.rootCause).toBe("DB connection pool exhausted");
    expect(report.confidence).toBe("high");
    expect(report.investigatedAt).toBeDefined();
    // LLM called 4 times: phases 2, 3, 4 (parallel) + phase 5
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(4);
  });

  it("runs phase 1 (anomaly detection) when no initial anomaly provided", async () => {
    const proactiveResponse = JSON.stringify({
      isAnomaly: true, severity: "high", summary: "High error rate",
      affectedMetrics: ["error_rate"], recommendedAction: "Investigate",
    });
    const llm = makeMockLlm([proactiveResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, undefined, "corr-002");

    expect(report.service).toBe("payments-api");
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(5);
  });

  it("returns no-anomaly report when phase 1 finds nothing", async () => {
    const noAnomalyResponse = JSON.stringify({
      isAnomaly: false, severity: "low", summary: "Service healthy",
      affectedMetrics: [], recommendedAction: "None",
    });
    const llm = makeMockLlm([noAnomalyResponse]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, undefined);

    expect(report.rootCause).toBe("No anomaly detected");
    expect(report.confidence).toBe("high");
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("degrades gracefully when a parallel phase fails", async () => {
    const failingLlm = {
      chat: vi.fn()
        .mockResolvedValueOnce({ type: "text", content: baseMetricFindings })
        .mockRejectedValueOnce(new Error("Loki unavailable"))  // log phase fails
        .mockResolvedValueOnce({ type: "text", content: baseInfraFindings })
        .mockResolvedValueOnce({ type: "text", content: JSON.stringify({
          severity: "high",
          summary: "High error rate",
          rootCause: "DB connection pool exhausted",
          evidence: { metrics: ["error_rate: 18%"], logs: [], infra: ["restarted 3x"] },
          recommendedActions: ["Scale connection pool"],
          confidence: "medium",
        }) }),
    } as unknown as LlmClient;
    const agent = new InvestigationAgent(failingLlm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly);

    // Should still complete — log phase failed but pipeline continued
    expect(report.service).toBe("payments-api");
    expect(report.rootCause).toBe("DB connection pool exhausted");
  });
});

import { describe, it, expect, vi } from "vitest";
import { InvestigationAgent, extractDashboardPanelHints } from "./investigation.js";
import type { LlmClient } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import type { AnomalyAssessment } from "./types.js";

const mockTools = [
  { type: "function" as const, function: { name: "query_prometheus", description: "", parameters: {} } },
  { type: "function" as const, function: { name: "search_dashboards", description: "", parameters: {} } },
  { type: "function" as const, function: { name: "get_dashboard_by_uid", description: "", parameters: {} } },
  { type: "function" as const, function: { name: "get_panel_image", description: "", parameters: {} } },
];

const fakeDashboards = JSON.stringify({ dashboards: [{ uid: "abc123", title: "Service Monitor" }] });
const fakeDashboardDetail = JSON.stringify({
  dashboard: {
    title: "Service Monitor",
    uid: "abc123",
    panels: [
      { id: 1, title: "Request Rate", type: "timeseries" },
      { id: 2, title: "Error Rate", type: "graph" },
    ],
  },
});

const mockMcp = {
  getTools: vi.fn().mockReturnValue(mockTools),
  callTool: vi.fn().mockImplementation((name: string) => {
    if (name === "search_dashboards") return Promise.resolve({ text: fakeDashboards, images: [] });
    if (name === "get_dashboard_by_uid") return Promise.resolve({ text: fakeDashboardDetail, images: [] });
    if (name === "get_panel_image") return Promise.resolve({ text: "", images: [{ data: "iVBOR...", mimeType: "image/png" }] });
    return Promise.resolve({ text: "metric data", images: [] });
  }),
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

  it("always captures panel images via deterministic capture", async () => {
    const llm = makeMockLlm([baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly, "corr-003");

    // Deterministic capture should produce images (2 panels in mock dashboard)
    expect(report.panelImages.length).toBeGreaterThanOrEqual(2);
    expect(report.panelImages[0]!.mimeType).toBe("image/png");
    // Verify get_panel_image was called
    const panelCalls = (mockMcp.callTool as ReturnType<typeof vi.fn>).mock.calls
      .filter(([name]: [string]) => name === "get_panel_image");
    expect(panelCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("ranks dashboards using user query hints over service tokens", async () => {
    // Mock dashboards where "Data Server Monitor" matches "server" and "Ingestion Monitor" matches "ingestion"
    const dashboardList = JSON.stringify([
      { uid: "ds1", title: "Data Server Monitor" },
      { uid: "ing1", title: "Ingestion Monitor" },
    ]);
    const ingestionDashboard = JSON.stringify({
      dashboard: {
        title: "Ingestion Monitor", uid: "ing1",
        panels: [
          { id: 10, title: "Ingestion Log Rate", type: "timeseries" },
          { id: 11, title: "Throughput", type: "graph" },
        ],
      },
    });
    const dataServerDashboard = JSON.stringify({
      dashboard: {
        title: "Data Server Monitor", uid: "ds1",
        panels: [
          { id: 1, title: "Data Server QPS", type: "timeseries" },
        ],
      },
    });
    const customMcp = {
      getTools: vi.fn().mockReturnValue(mockTools),
      callTool: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
        if (name === "search_dashboards") return Promise.resolve({ text: dashboardList, images: [] });
        if (name === "get_dashboard_by_uid" && args.uid === "ing1") return Promise.resolve({ text: ingestionDashboard, images: [] });
        if (name === "get_dashboard_by_uid" && args.uid === "ds1") return Promise.resolve({ text: dataServerDashboard, images: [] });
        if (name === "get_panel_image") return Promise.resolve({ text: "", images: [{ data: "img", mimeType: "image/png" }] });
        if (name === "list_datasources") return Promise.resolve({ text: "[]", images: [] });
        return Promise.resolve({ text: "{}", images: [] });
      }),
    } as unknown as McpClient;

    const llm = makeMockLlm([baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport]);
    const agent = new InvestigationAgent(llm, customMcp, { maxIterations: 5 });

    const report = await agent.investigate(
      { name: "ingestion-server", metrics: [{ query: "rate(logs[5m])", description: "log rate" }], logLabels: { app: "ingestion-server" } },
      anomaly, "corr-hints",
      undefined,
      "(Ingestion Log Rate in Ingestion monitor). find it and investigate",
    );

    // The first get_panel_image call should target the Ingestion Monitor dashboard (uid: ing1)
    const panelCalls = (customMcp.callTool as ReturnType<typeof vi.fn>).mock.calls
      .filter(([name]: [string]) => name === "get_panel_image");
    expect(panelCalls.length).toBeGreaterThanOrEqual(1);
    expect(panelCalls[0]![1].dashboardUid).toBe("ing1");
  });

});

describe("extractDashboardPanelHints", () => {
  it("extracts hints from parenthetical pattern", () => {
    const result = extractDashboardPanelHints("(Ingestion Log Rate in Ingestion monitor)");
    expect(result.panelHint).toBe("Ingestion Log Rate");
    expect(result.dashboardHint).toBe("Ingestion monitor");
  });

  it("extracts hints from non-paren pattern with dashboard/monitor suffix", () => {
    const result = extractDashboardPanelHints("Check Error Rate in Service Dashboard please");
    expect(result.panelHint).toBe("Check Error Rate");
    expect(result.dashboardHint).toBe("Service Dashboard");
  });

  it("returns nulls when no hints found", () => {
    const result = extractDashboardPanelHints("investigate the ingestion server");
    expect(result.panelHint).toBeNull();
    expect(result.dashboardHint).toBeNull();
  });

  it("handles undefined inputs", () => {
    const result = extractDashboardPanelHints(undefined, undefined);
    expect(result.panelHint).toBeNull();
    expect(result.dashboardHint).toBeNull();
  });
});

describe("InvestigationAgent – degradation", () => {
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

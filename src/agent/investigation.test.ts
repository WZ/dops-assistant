import { describe, it, expect, vi } from "vitest";
import { InvestigationAgent, extractDashboardPanelHints, buildTimeline, validateSeverity, repairTruncatedJson } from "./investigation.js";
import type { LlmClient } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import type { AnomalyAssessment } from "./types.js";
import type { MetricFindings, LogFindings, InfraFindings } from "./rca-types.js";

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

// New structured mock data
const basePlanResponse = JSON.stringify({
  hypotheses: [
    { hypothesis: "DB connection pool exhausted", evidenceNeeded: "Check connection pool metrics and error logs" },
  ],
  metricFocus: ["error_rate", "connection_pool_usage"],
  logFocus: ["connection timeout errors"],
  infraFocus: ["pod restarts"],
});

const baseMetricFindings = JSON.stringify({
  observations: [
    { metric: "rate(errors[5m])", currentValue: "18%", baselineValue: "0.2%", timestamp: "14:32 UTC", severity: "critical" },
  ],
  anomalyWindow: "14:28-15:10 UTC",
  summary: "Error rate spiked from 0.2% to 18% at 14:32 UTC",
});

const baseLogFindings = JSON.stringify({
  observations: [
    { pattern: "connection timeout", count: "47", firstSeen: "14:30 UTC", lastSeen: "14:55 UTC", sample: "[14:30:01] ERROR connection timeout to db-primary", sampleLines: ["[14:30:01] ERROR connection timeout to db-primary:5432 after 30s", "[14:32:15] ERROR connection timeout to db-primary:5432 after 30s"] },
  ],
  summary: "47 connection timeout errors between 14:30 and 14:55 UTC",
});

const baseInfraFindings = JSON.stringify({
  observations: [
    { resource: "payments-api-pod-1", status: "CrashLoopBackOff", detail: "restarted 3x in 10min", timestamp: "14:35 UTC" },
  ],
  summary: "Pod payments-api-pod-1 in CrashLoopBackOff with 3 restarts",
});

const baseRcaReport = JSON.stringify({
  severity: "high",
  summary: "High error rate caused by DB connection pool exhaustion",
  impact: { duration: "25 minutes (14:30–14:55 UTC)", description: "Error rate spiked to 18% affecting checkout flow" },
  trigger: "Traffic spike saturated connection pool",
  rootCause: "DB connection pool exhausted",
  contributingFactors: ["No auto-scaling on connection pool"],
  timeline: [
    { time: "14:30 UTC", event: "Traffic spike begins" },
    { time: "14:35 UTC", event: "Connection pool saturated" },
  ],
  evidence: { metrics: ["error_rate: 18%"], logs: ["connection timeout"], infra: ["restarted 3x"] },
  dashboardLinks: [],
  recommendedActions: ["Scale connection pool"],
  confidence: "high",
});

const baseReflectionResponse = JSON.stringify({
  validationNotes: "Report is consistent with evidence. Root cause explains all symptoms.",
  revisedRootCause: "DB connection pool exhausted",
  revisedTrigger: "Traffic spike saturated connection pool",
  revisedConfidence: "high",
  revisedSummary: "High error rate caused by DB connection pool exhaustion",
  issues: [],
});

const service = { name: "payments-api", metrics: [{ query: 'rate(errors[5m])', description: "error rate" }], logLabels: { app: "payments-api" } };

const anomaly: AnomalyAssessment = {
  isAnomaly: true,
  severity: "high",
  summary: "High error rate",
  affectedMetrics: ["error_rate"],
  recommendedAction: "Investigate",
  timeRangeFrom: "2026-03-05T00:00:00Z",
  timeRangeTo: "2026-03-05T23:59:59Z",
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
  it("runs planning + phases 2/3/4 + synthesis + reflection", async () => {
    // 6 LLM calls: plan, metrics, logs, infra, synthesis, reflection
    const llm = makeMockLlm([basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport, baseReflectionResponse]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly, "corr-001");

    expect(report.service).toBe("payments-api");
    expect(report.rootCause).toBe("DB connection pool exhausted");
    expect(report.confidence).toBe("high");
    expect(report.investigatedAt).toBeDefined();
    // LLM called 6 times: plan + phases 2, 3, 4 (parallel) + synthesis + reflection
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(6);
  });

  it("runs phase 1 (anomaly detection) when no initial anomaly provided", async () => {
    const proactiveResponse = JSON.stringify({
      isAnomaly: true, severity: "high", summary: "High error rate",
      affectedMetrics: ["error_rate"], recommendedAction: "Investigate",
      timeRangeFrom: "2026-03-05T00:00:00Z", timeRangeTo: "2026-03-05T23:59:59Z",
    });
    // 7 LLM calls: phase1, plan, metrics, logs, infra, synthesis, reflection
    const llm = makeMockLlm([proactiveResponse, basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport, baseReflectionResponse]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, undefined, "corr-002");

    expect(report.service).toBe("payments-api");
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(7);
  });

  it("returns no-anomaly report when phase 1 finds nothing", async () => {
    const noAnomalyResponse = JSON.stringify({
      isAnomaly: false, severity: "low", summary: "Service healthy",
      affectedMetrics: [], recommendedAction: "None",
      timeRangeFrom: "now-6h", timeRangeTo: "now",
    });
    const llm = makeMockLlm([noAnomalyResponse]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, undefined);

    expect(report.rootCause).toBe("No anomaly detected");
    expect(report.confidence).toBe("high");
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("always captures panel images via deterministic capture", async () => {
    const llm = makeMockLlm([basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport, baseReflectionResponse]);
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

  it("passes plan focus areas to all phase prompts", async () => {
    const llm = makeMockLlm([basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport, baseReflectionResponse]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    await agent.investigate(service, anomaly, "corr-plan");

    // The metric/log/infra phase system prompts should contain focus areas from the plan
    const chatCalls = (llm.chat as ReturnType<typeof vi.fn>).mock.calls;
    // Call index 1, 2, 3 are the parallel phases (after plan at index 0)
    // System prompt is messages[0].content
    const metricSystemPrompt = chatCalls[1]![0][0].content as string;
    expect(metricSystemPrompt).toContain("error_rate");
    expect(metricSystemPrompt).toContain("connection_pool_usage");

    const logSystemPrompt = chatCalls[2]![0][0].content as string;
    expect(logSystemPrompt).toContain("connection timeout errors");

    const infraSystemPrompt = chatCalls[3]![0][0].content as string;
    expect(infraSystemPrompt).toContain("pod restarts");
  });

  it("reflection no-op preserves original report when no issues found", async () => {
    const llm = makeMockLlm([basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport, baseReflectionResponse]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly, "corr-noop");

    // baseReflectionResponse has issues: [] so original report values should be preserved
    expect(report.rootCause).toBe("DB connection pool exhausted");
    expect(report.confidence).toBe("high");
    expect(report.summary).toBe("High error rate caused by DB connection pool exhaustion");
  });

  it("synthesis receives timeline in its input message", async () => {
    const llm = makeMockLlm([basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport, baseReflectionResponse]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    await agent.investigate(service, anomaly, "corr-timeline");

    const chatCalls = (llm.chat as ReturnType<typeof vi.fn>).mock.calls;
    // Synthesis is call index 4 (plan, metric, log, infra, synthesis, reflection)
    const synthesisUserMessage = chatCalls[4]![0][1].content as string;
    expect(synthesisUserMessage).toContain("EVENT TIMELINE");
    // Timeline should contain entries from the structured findings
    expect(synthesisUserMessage).toContain("[metric]");
    expect(synthesisUserMessage).toContain("[log]");
    expect(synthesisUserMessage).toContain("[infra]");
    // Hypotheses should be passed to synthesis
    expect(synthesisUserMessage).toContain("hypotheses");
  });

  it("reflection phase corrects low-confidence reports", async () => {
    const weakRcaReport = JSON.stringify({
      severity: "medium",
      summary: "Something might be wrong",
      impact: { duration: "Unknown", description: "Minor error rate increase" },
      trigger: "Unknown trigger",
      rootCause: "Unknown cause",
      contributingFactors: [],
      timeline: [],
      evidence: { metrics: ["error_rate: 5%"], logs: [], infra: [] },
      dashboardLinks: [],
      recommendedActions: ["Monitor"],
      confidence: "high", // overconfident
    });
    const correctionReflection = JSON.stringify({
      validationNotes: "Root cause is vague, confidence is overestimated given only 1 evidence type",
      revisedRootCause: "Likely intermittent network issue based on error rate spike",
      revisedTrigger: "Brief network disruption",
      revisedConfidence: "low",
      revisedSummary: "Intermittent error rate increase, cause uncertain",
      issues: ["Root cause too vague", "Confidence overestimated with only metric evidence"],
    });

    const llm = makeMockLlm([basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, weakRcaReport, correctionReflection]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly, "corr-reflect");

    // Reflection should have corrected the report
    expect(report.rootCause).toBe("Likely intermittent network issue based on error rate spike");
    expect(report.confidence).toBe("low");
    expect(report.summary).toBe("Intermittent error rate increase, cause uncertain");
  });

  it("ranks dashboards using user query hints over service tokens", async () => {
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

    const llm = makeMockLlm([basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport, baseReflectionResponse]);
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

  it("retries synthesis when root cause is non-conclusive and evidence exists", async () => {
    const nonConclusiveReport = JSON.stringify({
      severity: "medium",
      summary: "Ingestion rate dropped",
      impact: { duration: "3 hours", description: "30% drop" },
      trigger: "Unknown",
      rootCause: "Not yet identified — pending further investigation",
      contributingFactors: [],
      timeline: [],
      evidence: { metrics: ["ingestion_rate dropped 30%"], logs: ["Kafka connection errors"], infra: [] },
      dashboardLinks: [],
      recommendedActions: ["Investigate Kafka"],
      confidence: "low",
    });
    const conclusiveReport = JSON.stringify({
      severity: "medium",
      summary: "Ingestion rate dropped due to Kafka failure",
      impact: { duration: "3 hours", description: "30% drop" },
      trigger: "Kafka broker restart",
      rootCause: "Kafka broker-5 restarted, causing producer connection failures and ingestion back-pressure",
      contributingFactors: ["No retry backoff configured"],
      timeline: [{ time: "14:30 UTC", event: "Kafka broker restart" }],
      evidence: { metrics: ["ingestion_rate dropped 30%"], logs: ["Kafka connection errors"], infra: [] },
      dashboardLinks: [],
      recommendedActions: ["Add retry backoff"],
      confidence: "medium",
    });

    // LLM calls: plan, metrics, logs, infra, synthesis(non-conclusive), synthesis(retry), reflection
    const llm = makeMockLlm([
      basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings,
      nonConclusiveReport, conclusiveReport, baseReflectionResponse,
    ]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly, "corr-quality");

    expect(report.rootCause).toContain("Kafka broker-5");
    // 7 calls: plan + 3 evidence + synthesis + synthesis retry + reflection
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(7);
  });

  it("keeps original synthesis when root cause is conclusive", async () => {
    // 6 LLM calls: plan, metrics, logs, infra, synthesis, reflection — no retry
    const llm = makeMockLlm([basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport, baseReflectionResponse]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly, "corr-no-retry");

    expect(report.rootCause).toBe("DB connection pool exhausted");
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(6);
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

describe("buildTimeline", () => {
  it("builds chronologically sorted timeline from structured findings", () => {
    const metrics: MetricFindings = {
      observations: [
        { metric: "error_rate", currentValue: "18%", baselineValue: "0.2%", timestamp: "14:32", severity: "critical" },
      ],
      anomalyWindow: "14:28-15:10",
      summary: "Error rate spiked",
    };
    const logs: LogFindings = {
      observations: [
        { pattern: "connection timeout", count: "47", firstSeen: "14:30", lastSeen: "14:55", sample: "ERROR timeout", sampleLines: [] },
      ],
      summary: "Connection timeouts",
    };
    const infra: InfraFindings = {
      observations: [
        { resource: "pod-1", status: "CrashLoopBackOff", detail: "3 restarts", timestamp: "14:35" },
      ],
      summary: "Pod crash",
    };

    const timeline = buildTimeline(metrics, logs, infra);

    // Should be sorted chronologically: 14:30, 14:32, 14:35
    const lines = timeline.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("14:30");
    expect(lines[0]).toContain("[log]");
    expect(lines[1]).toContain("14:32");
    expect(lines[1]).toContain("[metric]");
    expect(lines[2]).toContain("14:35");
    expect(lines[2]).toContain("[infra]");
  });

  it("returns empty string when no timestamped observations exist", () => {
    const empty: MetricFindings = { observations: [], anomalyWindow: "unknown", summary: "" };
    const emptyLogs: LogFindings = { observations: [], summary: "" };
    const emptyInfra: InfraFindings = { observations: [], summary: "" };

    expect(buildTimeline(empty, emptyLogs, emptyInfra)).toBe("");
  });

  it("includes detail content in timeline entries", () => {
    const metrics: MetricFindings = {
      observations: [
        { metric: "http_errors", currentValue: "500/s", baselineValue: "10/s", timestamp: "10:00", severity: "critical" },
      ],
      anomalyWindow: "10:00-11:00",
      summary: "",
    };
    const logs: LogFindings = {
      observations: [
        { pattern: "OOM killed", count: "3", firstSeen: "10:05", lastSeen: "10:30", sample: "killed process", sampleLines: [] },
      ],
      summary: "",
    };
    const infra: InfraFindings = {
      observations: [
        { resource: "node-2", status: "NotReady", detail: "memory pressure", timestamp: "10:02" },
      ],
      summary: "",
    };

    const timeline = buildTimeline(metrics, logs, infra);
    expect(timeline).toContain("http_errors: 500/s (baseline: 10/s)");
    expect(timeline).toContain("OOM killed (count: 3)");
    expect(timeline).toContain("node-2: NotReady");
  });

  it("handles multiple observations from the same source", () => {
    const metrics: MetricFindings = {
      observations: [
        { metric: "latency_p99", currentValue: "800ms", baselineValue: "50ms", timestamp: "09:00", severity: "critical" },
        { metric: "error_rate", currentValue: "15%", baselineValue: "0.1%", timestamp: "09:05", severity: "critical" },
        { metric: "throughput", currentValue: "100/s", baselineValue: "1000/s", timestamp: "09:02", severity: "warning" },
      ],
      anomalyWindow: "09:00-10:00",
      summary: "",
    };
    const emptyLogs: LogFindings = { observations: [], summary: "" };
    const emptyInfra: InfraFindings = { observations: [], summary: "" };

    const timeline = buildTimeline(metrics, emptyLogs, emptyInfra);
    const lines = timeline.split("\n");
    expect(lines).toHaveLength(3);
    // Should be sorted: 09:00, 09:02, 09:05
    expect(lines[0]).toContain("09:00");
    expect(lines[0]).toContain("latency_p99");
    expect(lines[1]).toContain("09:02");
    expect(lines[1]).toContain("throughput");
    expect(lines[2]).toContain("09:05");
    expect(lines[2]).toContain("error_rate");
  });
});

describe("InvestigationAgent – degradation", () => {
  it("degrades gracefully when a parallel phase fails", async () => {
    const failingLlm = {
      chat: vi.fn()
        .mockResolvedValueOnce({ type: "text", content: basePlanResponse })  // plan phase
        .mockResolvedValueOnce({ type: "text", content: baseMetricFindings })
        .mockRejectedValueOnce(new Error("Loki unavailable"))  // log phase fails
        .mockResolvedValueOnce({ type: "text", content: baseInfraFindings })
        .mockResolvedValueOnce({ type: "text", content: JSON.stringify({
          severity: "high",
          summary: "High error rate",
          impact: { duration: "25 minutes", description: "Error rate spiked to 18%" },
          trigger: "Traffic spike",
          rootCause: "DB connection pool exhausted",
          contributingFactors: [],
          timeline: [],
          evidence: { metrics: ["error_rate: 18%"], logs: [], infra: ["restarted 3x"] },
          dashboardLinks: [],
          recommendedActions: ["Scale connection pool"],
          confidence: "medium",
        }) })
        .mockResolvedValueOnce({ type: "text", content: baseReflectionResponse }),  // reflection
    } as unknown as LlmClient;
    const agent = new InvestigationAgent(failingLlm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly);

    // Should still complete — log phase failed but pipeline continued
    expect(report.service).toBe("payments-api");
    expect(report.rootCause).toBe("DB connection pool exhausted");
  });
});

describe("validateSeverity", () => {
  const normalMetrics: MetricFindings = {
    observations: [{ metric: "rate", currentValue: "200k", baselineValue: "200k", timestamp: "now", severity: "normal" }],
    anomalyWindow: "none",
    summary: "No anomaly detected. Metrics are within normal range.",
  };
  const normalLogs: LogFindings = {
    observations: [],
    summary: "No errors or anomalies found in logs.",
  };
  const normalInfra: InfraFindings = {
    observations: [],
    summary: "Infrastructure is stable and healthy.",
  };

  it("overrides high severity to low when all evidence says no anomaly", () => {
    const report = {
      severity: "high",
      summary: "No anomaly detected in the ingestion log rate.",
      rootCause: "No abnormal behavior was observed. The metric stayed within expected limits.",
    };
    expect(validateSeverity(report, normalMetrics, normalLogs, normalInfra)).toBe("low");
  });

  it("overrides medium severity to low when findings are all normal", () => {
    const report = {
      severity: "medium",
      summary: "The system operated normally with no issues.",
      rootCause: "Normal traffic — no anomaly found.",
    };
    expect(validateSeverity(report, normalMetrics, normalLogs, normalInfra)).toBe("low");
  });

  it("returns null when severity is already low", () => {
    const report = {
      severity: "low",
      summary: "No anomaly detected.",
      rootCause: "Everything is normal.",
    };
    expect(validateSeverity(report, normalMetrics, normalLogs, normalInfra)).toBeNull();
  });

  it("returns null when there are actual elevated metrics", () => {
    const elevatedMetrics: MetricFindings = {
      observations: [{ metric: "error_rate", currentValue: "50%", baselineValue: "1%", timestamp: "now", severity: "critical" }],
      anomalyWindow: "last 2h",
      summary: "Error rate spiked to 50%.",
    };
    const report = {
      severity: "high",
      summary: "Error rate spike detected.",
      rootCause: "Database connection failure causing errors.",
    };
    expect(validateSeverity(report, elevatedMetrics, normalLogs, normalInfra)).toBeNull();
  });

  it("overrides when report summary contradicts severity despite phase summaries being unavailable", () => {
    const unavailableMetrics: MetricFindings = { observations: [], anomalyWindow: "unknown", summary: "unavailable" };
    const unavailableLogs: LogFindings = { observations: [], summary: "unavailable" };
    const unavailableInfra: InfraFindings = { observations: [], summary: "unavailable" };
    const report = {
      severity: "high",
      summary: "No anomaly was found. Everything is stable.",
      rootCause: "No issues detected within the expected range.",
    };
    expect(validateSeverity(report, unavailableMetrics, unavailableLogs, unavailableInfra)).toBe("low");
  });
});

describe("extractTimeRange (fallback)", () => {
  const agent = new InvestigationAgent(
    {} as any,
    { getTools: () => [], callTool: async () => ({ text: "", images: [] }) } as any,
    { maxIterations: 1 },
  );

  it("handles ISO date", () => {
    const range = agent.extractTimeRange("anomaly on 2026-03-05", "");
    expect(range).toEqual({ from: "2026-03-05T00:00:00Z", to: "2026-03-05T23:59:59Z" });
  });

  it("handles Unicode dashes in ISO date", () => {
    const range = agent.extractTimeRange("anomaly on 2026\u201103\u201105", "");
    expect(range).toEqual({ from: "2026-03-05T00:00:00Z", to: "2026-03-05T23:59:59Z" });
  });

  it("defaults to last 6h when no ISO date found", () => {
    const range = agent.extractTimeRange("ingestion rate anomaly", "investigate ingestion");
    expect(range).toEqual({ from: "now-6h", to: "now" });
  });
});

describe("repairTruncatedJson", () => {
  it("returns valid JSON unchanged", () => {
    const valid = '{"severity":"high","summary":"Error spike"}';
    expect(repairTruncatedJson(valid)).toBe(valid);
  });

  it("repairs truncated string value", () => {
    const truncated = '{"severity":"high","summary":"Error spike at 14:';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.severity).toBe("high");
    expect(parsed.summary).toContain("Error spike");
  });

  it("repairs truncated array", () => {
    const truncated = '{"items":["a","b","c';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.items).toContain("a");
    expect(parsed.items).toContain("b");
  });

  it("repairs truncated nested object", () => {
    const truncated = '{"impact":{"duration":"25 min","description":"Error';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.impact.duration).toBe("25 min");
  });

  it("repairs truncated mid-key", () => {
    const truncated = '{"severity":"high","summ';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.severity).toBe("high");
  });

  it("returns original string if unrepairable", () => {
    const garbage = "not json at all";
    expect(repairTruncatedJson(garbage)).toBe(garbage);
  });
});

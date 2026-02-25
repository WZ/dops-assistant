import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSchedule, mockTask } = vi.hoisted(() => {
  const mockTask = { stop: vi.fn() };
  const mockSchedule = vi.fn();
  return { mockSchedule, mockTask };
});

vi.mock("pino", () => ({
  default: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
  })),
}));

vi.mock("node-cron", () => ({
  default: {
    schedule: mockSchedule,
  },
}));

import { Scheduler, parseDurationToCron, AlertDeduplicator } from "./scheduler.js";
import type { AgentCore } from "../agent/core.js";
import type { InvestigationAgent } from "../agent/investigation.js";
import type { sendAnomalyAlert } from "../notifications/slack-webhook.js";
import type { AnomalyAssessment } from "../agent/types.js";
import type { RcaReport } from "../agent/rca-types.js";

describe("parseDurationToCron", () => {
  it("converts 5m to cron expression", () => {
    expect(parseDurationToCron("5m")).toBe("*/5 * * * *");
  });

  it("converts 10m to cron expression", () => {
    expect(parseDurationToCron("10m")).toBe("*/10 * * * *");
  });

  it("converts 1h to cron expression", () => {
    expect(parseDurationToCron("1h")).toBe("0 */1 * * *");
  });

  it("throws on invalid format", () => {
    expect(() => parseDurationToCron("invalid")).toThrow("Unsupported interval format");
  });

  it("throws on 0m interval", () => {
    expect(() => parseDurationToCron("0m")).toThrow("Unsupported interval format");
  });

  it("throws on 0h interval", () => {
    expect(() => parseDurationToCron("0h")).toThrow("Unsupported interval format");
  });
});

describe("AlertDeduplicator", () => {
  it("allows alert on first occurrence", () => {
    const dedup = new AlertDeduplicator(30);
    expect(dedup.shouldAlert("svc")).toBe(true);
  });

  it("suppresses alert within cooldown window", () => {
    const dedup = new AlertDeduplicator(30);
    dedup.record("svc");
    expect(dedup.shouldAlert("svc")).toBe(false);
  });

  it("allows alert after cooldown expires", () => {
    vi.useFakeTimers();
    const dedup = new AlertDeduplicator(30);
    dedup.record("svc");
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(dedup.shouldAlert("svc")).toBe(true);
    vi.useRealTimers();
  });
});

describe("Scheduler", () => {
  let capturedCallback: (() => void) | null = null;

  const mockRun = vi.fn();
  const mockAgent = { run: mockRun } as unknown as AgentCore;
  const mockNotify = vi.fn() as unknown as typeof sendAnomalyAlert;

  const services = [
    { name: "payments-api", metrics: [], logLabels: {} },
    { name: "checkout-service", metrics: [], logLabels: {} },
  ];

  const healthyAssessment: AnomalyAssessment = {
    isAnomaly: false,
    severity: "low",
    summary: "All healthy",
    affectedMetrics: [],
    recommendedAction: "No action",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallback = null;
    mockSchedule.mockImplementation((_expr: string, callback: () => void) => {
      capturedCallback = callback;
      return mockTask;
    });
  });

  it("calls agent for each service on tick", async () => {
    mockRun.mockResolvedValue({ response: JSON.stringify(healthyAssessment), updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api", "checkout-service"], maxConcurrency: 5, alertCooldownMinutes: 30 },
      services,
      mockAgent,
      mockNotify,
    );
    scheduler.start();

    await capturedCallback!();

    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ mode: "proactive" }));
  });

  it("calls notifier when agent response signals anomaly", async () => {
    const assessment: AnomalyAssessment = {
      isAnomaly: true,
      severity: "high",
      summary: "High latency detected on payments-api: P99 is 4.2s",
      affectedMetrics: ["P99 latency"],
      recommendedAction: "Check recent deploys",
    };
    mockRun.mockResolvedValue({ response: JSON.stringify(assessment), updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api"], maxConcurrency: 5, alertCooldownMinutes: 30 },
      services,
      mockAgent,
      mockNotify,
      "https://hooks.slack.com/test",
    );
    scheduler.start();

    await capturedCallback!();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ service: "payments-api" }),
    );
  });

  it("does not call notifier when agent says healthy", async () => {
    mockRun.mockResolvedValue({ response: JSON.stringify(healthyAssessment), updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api"], maxConcurrency: 5, alertCooldownMinutes: 30 },
      services,
      mockAgent,
      mockNotify,
    );
    scheduler.start();

    await capturedCallback!();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("stop() calls task.stop()", () => {
    mockRun.mockResolvedValue({ response: JSON.stringify(healthyAssessment), updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api"], maxConcurrency: 5, alertCooldownMinutes: 30 },
      services,
      mockAgent,
      mockNotify,
    );
    scheduler.start();
    scheduler.stop();

    expect(mockTask.stop).toHaveBeenCalled();
  });

  it("calling start() twice only creates one cron task", () => {
    mockRun.mockResolvedValue({ response: JSON.stringify(healthyAssessment), updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "1m", services: ["payments-api"], maxConcurrency: 5, alertCooldownMinutes: 30 },
      services,
      mockAgent,
      mockNotify,
    );
    scheduler.start();
    scheduler.start();

    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });
});

describe("Scheduler – structured anomaly detection", () => {
  let scheduler: Scheduler;
  let mockAgent: { run: ReturnType<typeof vi.fn> };
  let mockNotify: ReturnType<typeof vi.fn>;
  const service = {
    name: "payments-api",
    metrics: [{ query: "up", description: "Up" }],
    logLabels: {},
  };

  beforeEach(() => {
    mockAgent = { run: vi.fn() };
    mockNotify = vi.fn().mockResolvedValue(undefined);
    scheduler = new Scheduler(
      { interval: "5m", maxConcurrency: 3, alertCooldownMinutes: 30 },
      [service],
      mockAgent as unknown as AgentCore,
      mockNotify as typeof sendAnomalyAlert,
      "https://hooks.slack.com/test",
    );
  });

  it("sends alert when isAnomaly is true", async () => {
    const assessment: AnomalyAssessment = {
      isAnomaly: true,
      severity: "high",
      summary: "Latency spike detected",
      affectedMetrics: ["P99 latency"],
      recommendedAction: "Check recent deploys",
    };
    mockAgent.run.mockResolvedValueOnce({
      response: JSON.stringify(assessment),
      updatedHistory: [],
    });
    await scheduler.checkService(service);
    expect(mockNotify).toHaveBeenCalledOnce();
    expect(mockNotify).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({ severity: "high", recommendedAction: "Check recent deploys" }),
    );
  });

  it("does not send alert when isAnomaly is false", async () => {
    const assessment: AnomalyAssessment = {
      isAnomaly: false,
      severity: "low",
      summary: "All metrics normal",
      affectedMetrics: [],
      recommendedAction: "No action needed",
    };
    mockAgent.run.mockResolvedValueOnce({
      response: JSON.stringify(assessment),
      updatedHistory: [],
    });
    await scheduler.checkService(service);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does not send alert when JSON parse fails", async () => {
    mockAgent.run.mockResolvedValueOnce({
      response: "not valid json",
      updatedHistory: [],
    });
    await scheduler.checkService(service);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe("Scheduler – RCA integration", () => {
  const service = { name: "test-service", metrics: [], logLabels: {} };

  const mockReport: RcaReport = {
    service: "test-service",
    severity: "high",
    summary: "High error rate",
    rootCause: "DB pool exhausted",
    evidence: { metrics: ["rate: 18%"], logs: [], infra: [] },
    recommendedActions: ["Scale DB"],
    confidence: "high",
    investigatedAt: new Date().toISOString(),
  };

  it("calls investigationAgent.investigate() when anomaly is detected", async () => {
    const mockAgent = { run: vi.fn() };
    const mockInvestigationAgent = {
      investigate: vi.fn().mockResolvedValue(mockReport),
    } as unknown as InvestigationAgent;
    const mockNotify = vi.fn().mockResolvedValue(undefined);

    const anomalyAssessment = JSON.stringify({
      isAnomaly: true, severity: "high", summary: "High error rate",
      affectedMetrics: ["error_rate"], recommendedAction: "Investigate",
    });
    mockAgent.run.mockResolvedValueOnce({ response: anomalyAssessment, updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "5m", maxConcurrency: 1, alertCooldownMinutes: 0 },
      [service],
      mockAgent as unknown as AgentCore,
      mockNotify as typeof sendAnomalyAlert,
      "https://hooks.slack.com/test",
      mockInvestigationAgent,
    );

    await scheduler.checkService(service);

    expect(mockInvestigationAgent.investigate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test-service" }),
      expect.objectContaining({ isAnomaly: true }),
      expect.any(String),
    );
    expect(mockNotify).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({ rca: mockReport }),
    );
  });

  it("still alerts even if investigation fails", async () => {
    const mockAgent = { run: vi.fn() };
    const mockInvestigationAgent = {
      investigate: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    } as unknown as InvestigationAgent;
    const mockNotify = vi.fn().mockResolvedValue(undefined);

    const anomalyAssessment = JSON.stringify({
      isAnomaly: true, severity: "high", summary: "High error rate",
      affectedMetrics: ["error_rate"], recommendedAction: "Investigate",
    });
    mockAgent.run.mockResolvedValueOnce({ response: anomalyAssessment, updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "5m", maxConcurrency: 1, alertCooldownMinutes: 0 },
      [service],
      mockAgent as unknown as AgentCore,
      mockNotify as typeof sendAnomalyAlert,
      "https://hooks.slack.com/test",
      mockInvestigationAgent,
    );

    await scheduler.checkService(service);

    // Alert still sent, just without rca field
    expect(mockNotify).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.not.objectContaining({ rca: expect.anything() }),
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InvestigationRunner, mapBackendPhase, friendlyError } from "./investigation-runner.js";
import type { InvestigationCallbacks } from "./investigation-runner.js";
import type { Database } from "./db.js";
import type { IInvestigationAgent } from "../types/agent-interfaces.js";
import type { RcaReport } from "../types/rca-types.js";

const MOCK_REPORT: RcaReport = {
  service: "test-service",
  severity: "high",
  summary: "Test summary",
  impact: { duration: "5m", description: "Test impact" },
  rootCause: "Memory leak",
  trigger: "Deploy",
  contributingFactors: [],
  timeline: [],
  evidence: { metrics: [], logs: [], infra: [] },
  dashboardLinks: [],
  recommendedActions: [],
  confidence: "high",
  confidenceScore: 0.9,
  investigatedAt: new Date().toISOString(),
};

function createMockDb(): Database {
  return {
    createInvestigation: vi.fn(),
    updateInvestigation: vi.fn(),
    getInvestigation: vi.fn(),
    createEvent: vi.fn(),
    createMessage: vi.fn(),
  } as unknown as Database;
}

function createMockAgent(report: RcaReport = MOCK_REPORT): IInvestigationAgent {
  return {
    investigate: vi.fn().mockResolvedValue(report),
  };
}

describe("InvestigationRunner", () => {
  let db: Database;
  let agent: IInvestigationAgent;

  beforeEach(() => {
    db = createMockDb();
    agent = createMockAgent();
  });

  it("creates DB record, runs investigation, and persists report", async () => {
    const runner = new InvestigationRunner({ db, investigationAgent: agent });
    const report = await runner.run({
      service: { name: "test-svc", metrics: [], logLabels: {} },
      message: "investigate test-svc",
      investigationId: "inv_test_1",
    });

    expect(report.rootCause).toBe("Memory leak");
    expect(db.createInvestigation).toHaveBeenCalledWith({
      id: "inv_test_1",
      service: "test-svc",
      query: "investigate test-svc",
      status: "running",
    });
    expect(db.updateInvestigation).toHaveBeenCalledWith("inv_test_1", expect.objectContaining({ status: "complete" }));
  });

  it("calls onComplete callback on success", async () => {
    const onComplete = vi.fn();
    const runner = new InvestigationRunner({ db, investigationAgent: agent });
    await runner.run({
      service: { name: "test-svc", metrics: [], logLabels: {} },
      message: "test",
      investigationId: "inv_test_2",
      callbacks: { onComplete },
    });

    expect(onComplete).toHaveBeenCalledWith("inv_test_2", expect.objectContaining({ rootCause: "Memory leak" }));
  });

  it("calls onFailed callback and marks DB as failed on error", async () => {
    const failAgent: IInvestigationAgent = {
      investigate: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    };
    const onFailed = vi.fn();
    const runner = new InvestigationRunner({ db, investigationAgent: failAgent });

    await expect(
      runner.run({
        service: { name: "test-svc", metrics: [], logLabels: {} },
        message: "test",
        investigationId: "inv_fail",
        callbacks: { onFailed },
      }),
    ).rejects.toThrow("LLM timeout");

    expect(onFailed).toHaveBeenCalledWith("inv_fail", expect.stringContaining("timed out"));
    expect(db.updateInvestigation).toHaveBeenCalledWith("inv_fail", { status: "failed" });
  });

  it("generates investigation ID if not provided", async () => {
    const runner = new InvestigationRunner({ db, investigationAgent: agent });
    await runner.run({
      service: { name: "test-svc", metrics: [], logLabels: {} },
      message: "test",
    });

    expect(db.createInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^inv_/) }),
    );
  });

  it("persists token usage to DB", async () => {
    // The agent mock doesn't call onTokenUsage, but the runner should still
    // persist total_input_tokens=0 and total_output_tokens=0
    const runner = new InvestigationRunner({ db, investigationAgent: agent });
    await runner.run({
      service: { name: "test-svc", metrics: [], logLabels: {} },
      message: "test",
      investigationId: "inv_tokens",
    });

    expect(db.updateInvestigation).toHaveBeenCalledWith("inv_tokens", expect.objectContaining({
      total_input_tokens: 0,
      total_output_tokens: 0,
    }));
  });
});

describe("mapBackendPhase", () => {
  it("maps anomaly detection to planning", () => {
    expect(mapBackendPhase("Detecting anomalies")).toEqual(["planning"]);
  });

  it("maps parallel evidence to multiple phases", () => {
    expect(mapBackendPhase("Analyzing metrics, logs & infrastructure")).toEqual(["metrics", "logs", "infra"]);
  });

  it("maps synthesis phases", () => {
    expect(mapBackendPhase("Building event timeline")).toEqual(["synthesis"]);
    expect(mapBackendPhase("Synthesizing root cause")).toEqual(["synthesis"]);
  });

  it("returns empty for unknown phases", () => {
    expect(mapBackendPhase("Unknown phase")).toEqual([]);
  });
});

describe("friendlyError", () => {
  it("maps timeout errors", () => {
    expect(friendlyError(new Error("ETIMEDOUT"))).toContain("timed out");
  });

  it("maps rate limit errors", () => {
    expect(friendlyError(new Error("429 Too Many Requests"))).toContain("rate limit");
  });

  it("maps gateway errors", () => {
    expect(friendlyError(new Error("502 Bad Gateway"))).toContain("unavailable");
  });

  it("passes through unknown errors", () => {
    expect(friendlyError(new Error("Something weird"))).toBe("Something weird");
  });
});

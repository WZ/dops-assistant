import { describe, it, expect, vi, beforeEach } from "vitest";
import { InvestigationRunner, mapBackendPhase, friendlyError } from "./investigation-runner.js";
import type { InvestigationCallbacks } from "./investigation-runner.js";
import type { Database } from "./db.js";
import type { IInvestigationAgent } from "../types/agent-interfaces.js";
import type { RcaReport } from "../types/rca-types.js";
import { eventLog } from "./event-log.js";

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
      stackId: "stack-1",
      source: "manual",
    });

    expect(report.rootCause).toBe("Memory leak");
    expect(db.createInvestigation).toHaveBeenCalledWith("stack-1", {
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
      source: "manual",
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
        source: "manual",
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
      source: "manual",
    });

    expect(db.createInvestigation).toHaveBeenCalledWith(
      "",
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
      source: "manual",
    });

    expect(db.updateInvestigation).toHaveBeenCalledWith("inv_tokens", expect.objectContaining({
      total_input_tokens: 0,
      total_output_tokens: 0,
    }));
  });
});

describe("eventLog integration", () => {
  let db: Database;
  let agent: IInvestigationAgent;

  beforeEach(() => {
    db = createMockDb();
    agent = createMockAgent();
    eventLog.reset();
  });

  it("emits investigation_started and investigation_completed on success", async () => {
    const runner = new InvestigationRunner({ db, investigationAgent: agent });
    await runner.run({
      service: { name: "test-svc", metrics: [], logLabels: {} },
      message: "investigate test-svc",
      investigationId: "inv_event_1",
      stackId: "stack-abc",
      source: "manual",
    });

    const { events } = eventLog.recent(10);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("investigation_started");
    expect(kinds).toContain("investigation_completed");

    const started = events.find((e) => e.kind === "investigation_started")!;
    expect(started.stackId).toBe("stack-abc");
    expect(started.service).toBe("test-svc");

    const completed = events.find((e) => e.kind === "investigation_completed")!;
    expect(completed.stackId).toBe("stack-abc");
    expect(completed.service).toBe("test-svc");
  });

  it("emits investigation_failed on agent error", async () => {
    const failAgent: IInvestigationAgent = {
      investigate: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    };
    const runner = new InvestigationRunner({ db, investigationAgent: failAgent });

    await expect(
      runner.run({
        service: { name: "test-svc", metrics: [], logLabels: {} },
        message: "test",
        investigationId: "inv_event_fail",
        stackId: "stack-xyz",
        source: "manual",
      }),
    ).rejects.toThrow("LLM timeout");

    const { events } = eventLog.recent(10);
    const failed = events.find((e) => e.kind === "investigation_failed");
    expect(failed).toBeDefined();
    expect(failed!.stackId).toBe("stack-xyz");
    expect(failed!.service).toBe("test-svc");
  });
});

describe("mapBackendPhase", () => {
  it("maps anomaly detection to planning", () => {
    expect(mapBackendPhase("Detecting anomalies")).toEqual(["planning"]);
  });

  it("maps parallel evidence to multiple phases", () => {
    expect(mapBackendPhase("Analyzing metrics, logs & infrastructure")).toEqual(["metrics", "logs", "infra", "changes"]);
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

  it("maps ENETUNREACH errors", () => {
    expect(friendlyError(new Error("Cannot connect to API: connect ENETUNREACH 10.83.127.21:443"))).toContain("unreachable");
  });

  it("maps 'Cannot connect to API' errors from AI SDK", () => {
    expect(friendlyError(new Error("Cannot connect to API: fetch failed"))).toContain("unreachable");
  });

  it("passes through unknown errors", () => {
    expect(friendlyError(new Error("Something weird"))).toBe("Something weird");
  });
});

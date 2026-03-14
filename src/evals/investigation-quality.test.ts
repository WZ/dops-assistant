import { describe, it, expect, vi } from "vitest";
import { evaluateReportQuality, shouldRetrySynthesis } from "./investigation-quality.js";
import type { RcaReport } from "../types/rca-types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeReport(overrides: Partial<RcaReport> = {}): RcaReport {
  return {
    service: "api-service",
    severity: "high",
    summary: "Error rate spike caused by memory exhaustion",
    impact: { duration: "25 min", description: "10% of requests failed" },
    trigger: "Deployment at 14:00 UTC",
    rootCause: "Unbounded cache growth in request handler caused heap exhaustion",
    contributingFactors: ["High traffic volume", "Missing eviction policy"],
    timeline: [],
    evidence: {
      metrics: ["CPU at 95%", "Heap usage at 98%"],
      logs: ["OOM error at 14:02 UTC", "GC pressure from 13:50 UTC"],
      infra: [],
    },
    dashboardLinks: [],
    recommendedActions: ["Set cache eviction TTL", "Add heap size monitoring alert"],
    confidence: "high",
    confidenceScore: 0.9,
    investigatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── evaluateReportQuality — heuristic path ────────────────────────────────────

describe("evaluateReportQuality — heuristic scoring", () => {
  it("conclusive report with evidence and actions scores above threshold on all dimensions", async () => {
    const report = makeReport();
    const score = await evaluateReportQuality(report);

    expect(score.conclusiveness).toBeGreaterThanOrEqual(0.5);
    expect(score.evidenceSupport).toBeGreaterThanOrEqual(0.5);
    expect(score.actionability).toBeGreaterThanOrEqual(0.5);
    expect(score.passed).toBe(true);
  });

  it("report with 'unable to determine' root cause scores below threshold on conclusiveness", async () => {
    const report = makeReport({ rootCause: "Unable to determine the root cause from available data." });
    const score = await evaluateReportQuality(report);

    expect(score.conclusiveness).toBeLessThan(0.5);
    expect(score.passed).toBe(false);
  });

  it("report with 'insufficient data' in root cause scores below threshold", async () => {
    const report = makeReport({ rootCause: "There was insufficient data to identify the failure." });
    const score = await evaluateReportQuality(report);

    expect(score.conclusiveness).toBeLessThan(0.5);
  });

  it("report with 'no clear' root cause scores below threshold", async () => {
    const report = makeReport({ rootCause: "There is no clear root cause identified at this time." });
    const score = await evaluateReportQuality(report);

    expect(score.conclusiveness).toBeLessThan(0.5);
  });

  it("very short root cause (< 20 chars) scores 0.1 conclusiveness", async () => {
    const report = makeReport({ rootCause: "Unknown" });
    const score = await evaluateReportQuality(report);

    expect(score.conclusiveness).toBe(0.1);
  });

  it("missing recommendations scores low on actionability", async () => {
    const report = makeReport({ recommendedActions: [] });
    const score = await evaluateReportQuality(report);

    expect(score.actionability).toBe(0.1);
  });

  it("single recommendation scores 0.5 on actionability", async () => {
    const report = makeReport({ recommendedActions: ["Increase heap size"] });
    const score = await evaluateReportQuality(report);

    expect(score.actionability).toBe(0.5);
  });

  it("two or more recommendations score 0.8 on actionability", async () => {
    const report = makeReport({ recommendedActions: ["Fix A", "Fix B"] });
    const score = await evaluateReportQuality(report);

    expect(score.actionability).toBe(0.8);
  });

  it("report with no metric evidence scores below 0.6 on evidenceSupport", async () => {
    const report = makeReport({ evidence: { metrics: [], logs: ["some log"], infra: [] } });
    const score = await evaluateReportQuality(report);

    // Base 0.3 + 0.3 for logs = 0.6 — still passes, but no metrics bonus
    expect(score.evidenceSupport).toBeLessThanOrEqual(0.6);
  });

  it("report with no log or metric evidence scores base 0.3 on evidenceSupport", async () => {
    const report = makeReport({ evidence: { metrics: [], logs: [], infra: [] } });
    const score = await evaluateReportQuality(report);

    expect(score.evidenceSupport).toBe(0.3);
    // 0.3 < 0.5 threshold, so passed should be false even if other dims pass
    expect(score.passed).toBe(false);
  });

  it("fully conclusive report with both metric and log evidence scores 0.9 on evidenceSupport", async () => {
    const report = makeReport({
      evidence: {
        metrics: ["CPU spike", "Memory growth"],
        logs: ["OOM error", "GC pause"],
        infra: [],
      },
    });
    const score = await evaluateReportQuality(report);

    // 0.3 base + 0.3 metrics + 0.3 logs = 0.9 (use toBeCloseTo for floating point)
    expect(score.evidenceSupport).toBeCloseTo(0.9, 5);
  });
});

// ── shouldRetrySynthesis ──────────────────────────────────────────────────────

describe("shouldRetrySynthesis", () => {
  it("returns true when report did not pass", () => {
    const scores = { conclusiveness: 0.3, evidenceSupport: 0.3, actionability: 0.1, passed: false };
    expect(shouldRetrySynthesis(scores)).toBe(true);
  });

  it("returns false when report passed", () => {
    const scores = { conclusiveness: 0.8, evidenceSupport: 0.9, actionability: 0.8, passed: true };
    expect(shouldRetrySynthesis(scores)).toBe(false);
  });

  it("returns true even when only one dimension is below threshold", () => {
    const scores = { conclusiveness: 0.8, evidenceSupport: 0.9, actionability: 0.1, passed: false };
    expect(shouldRetrySynthesis(scores)).toBe(true);
  });
});

// ── evaluateReportQuality — model-graded path ─────────────────────────────────

describe("evaluateReportQuality — model-graded path", () => {
  it("uses evaluator output when it returns valid JSON scores", async () => {
    const evaluator = vi.fn().mockResolvedValue(
      JSON.stringify({ conclusiveness: 0.9, evidenceSupport: 0.85, actionability: 0.75 }),
    );
    const report = makeReport();
    const score = await evaluateReportQuality(report, evaluator);

    expect(evaluator).toHaveBeenCalledOnce();
    expect(score.conclusiveness).toBe(0.9);
    expect(score.evidenceSupport).toBe(0.85);
    expect(score.actionability).toBe(0.75);
    expect(score.passed).toBe(true);
  });

  it("falls back to heuristic scoring when evaluator throws", async () => {
    const evaluator = vi.fn().mockRejectedValue(new Error("LLM unavailable"));
    const report = makeReport(); // conclusive report
    const score = await evaluateReportQuality(report, evaluator);

    // Should have fallen back to heuristics — conclusive report passes
    expect(score.passed).toBe(true);
    expect(score.conclusiveness).toBe(0.8);
  });

  it("falls back to heuristic scoring when evaluator returns invalid JSON", async () => {
    const evaluator = vi.fn().mockResolvedValue("not valid json");
    const report = makeReport({ recommendedActions: [] }); // no actions — should fail actionability
    const score = await evaluateReportQuality(report, evaluator);

    // Heuristic path: 0 actions → 0.1 actionability → not passed
    expect(score.actionability).toBe(0.1);
    expect(score.passed).toBe(false);
  });

  it("falls back to heuristic when evaluator returns NaN scores", async () => {
    const evaluator = vi.fn().mockResolvedValue(
      JSON.stringify({ conclusiveness: "high", evidenceSupport: null, actionability: undefined }),
    );
    const report = makeReport();
    const score = await evaluateReportQuality(report, evaluator);

    // Heuristic fallback — conclusive report passes
    expect(score.passed).toBe(true);
  });

  it("clamps evaluator scores to [0, 1] range", async () => {
    const evaluator = vi.fn().mockResolvedValue(
      JSON.stringify({ conclusiveness: 1.5, evidenceSupport: -0.2, actionability: 0.7 }),
    );
    const report = makeReport();
    const score = await evaluateReportQuality(report, evaluator);

    expect(score.conclusiveness).toBe(1.0);
    expect(score.evidenceSupport).toBe(0.0);
    expect(score.actionability).toBe(0.7);
  });
});

// ── End-to-end scenario ───────────────────────────────────────────────────────

describe("quality eval end-to-end scenarios", () => {
  it("inconclusive report should trigger retry", async () => {
    const report = makeReport({
      rootCause: "Unable to determine root cause.",
      recommendedActions: [],
      evidence: { metrics: [], logs: [], infra: [] },
    });
    const score = await evaluateReportQuality(report);

    expect(score.passed).toBe(false);
    expect(shouldRetrySynthesis(score)).toBe(true);
  });

  it("high-quality report should not trigger retry", async () => {
    const report = makeReport(); // all fields well-populated
    const score = await evaluateReportQuality(report);

    expect(score.passed).toBe(true);
    expect(shouldRetrySynthesis(score)).toBe(false);
  });
});

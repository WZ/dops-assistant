import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { severityVariant, formatDuration, normalizeConfidence, timeAgo, computeKpiData } from "./dashboard-utils.js";
import type { InvestigationSummary } from "./dashboard-utils.js";

describe("severityVariant", () => {
  it("maps critical to destructive", () => {
    expect(severityVariant("critical")).toBe("destructive");
    expect(severityVariant("CRITICAL")).toBe("destructive");
    expect(severityVariant("Critical")).toBe("destructive");
  });

  it("maps high to warning", () => {
    expect(severityVariant("high")).toBe("warning");
  });

  it("maps medium to secondary", () => {
    expect(severityVariant("medium")).toBe("secondary");
  });

  it("maps low and unknown to outline", () => {
    expect(severityVariant("low")).toBe("outline");
    expect(severityVariant("unknown")).toBe("outline");
    expect(severityVariant("")).toBe("outline");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats minute durations", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  it("formats hour durations", () => {
    expect(formatDuration(3600000)).toBe("1h");
    expect(formatDuration(5400000)).toBe("1h 30m");
    expect(formatDuration(7380000)).toBe("2h 3m");
  });

  it("omits zero remainders", () => {
    expect(formatDuration(120000)).toBe("2m");
    expect(formatDuration(7200000)).toBe("2h");
  });
});

describe("normalizeConfidence", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(normalizeConfidence(null)).toBe("");
    expect(normalizeConfidence(undefined)).toBe("");
    expect(normalizeConfidence("")).toBe("");
  });

  it("converts numeric floats (0-1) to percentage", () => {
    expect(normalizeConfidence(0.87)).toBe("87%");
    expect(normalizeConfidence(0.5)).toBe("50%");
    expect(normalizeConfidence(1)).toBe("100%");
    expect(normalizeConfidence(0)).toBe("0%");
  });

  it("converts confidenceScore (0-100) to percentage", () => {
    expect(normalizeConfidence(87)).toBe("87%");
    expect(normalizeConfidence(50)).toBe("50%");
    expect(normalizeConfidence(100)).toBe("100%");
  });

  it("passes through strings with %", () => {
    expect(normalizeConfidence("87%")).toBe("87%");
    expect(normalizeConfidence("50%")).toBe("50%");
  });

  it("appends % to numeric strings", () => {
    expect(normalizeConfidence("87")).toBe("87%");
  });

  it("returns non-numeric strings as-is", () => {
    expect(normalizeConfidence("high")).toBe("high");
    expect(normalizeConfidence("medium")).toBe("medium");
    expect(normalizeConfidence("low")).toBe("low");
  });
});

// ─── timeAgo ───────────────────────────────────────────────────────────────

describe("timeAgo", () => {
  const NOW = new Date("2025-06-01T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for <1 minute", () => {
    const date = new Date(NOW - 30_000).toISOString(); // 30 seconds ago
    expect(timeAgo(date)).toBe("just now");
  });

  it("returns minutes for 1-59 minutes", () => {
    const date1 = new Date(NOW - 60_000).toISOString(); // 1 min ago
    expect(timeAgo(date1)).toBe("1m ago");

    const date30 = new Date(NOW - 30 * 60_000).toISOString(); // 30 min ago
    expect(timeAgo(date30)).toBe("30m ago");

    const date59 = new Date(NOW - 59 * 60_000).toISOString(); // 59 min ago
    expect(timeAgo(date59)).toBe("59m ago");
  });

  it("returns hours for 1-23 hours", () => {
    const date1h = new Date(NOW - 60 * 60_000).toISOString(); // 1 hour ago
    expect(timeAgo(date1h)).toBe("1h ago");

    const date12h = new Date(NOW - 12 * 60 * 60_000).toISOString(); // 12 hours ago
    expect(timeAgo(date12h)).toBe("12h ago");

    const date23h = new Date(NOW - 23 * 60 * 60_000).toISOString(); // 23 hours ago
    expect(timeAgo(date23h)).toBe("23h ago");
  });

  it("returns days for 24+ hours", () => {
    const date1d = new Date(NOW - 24 * 60 * 60_000).toISOString(); // 1 day ago
    expect(timeAgo(date1d)).toBe("1d ago");

    const date3d = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString(); // 3 days ago
    expect(timeAgo(date3d)).toBe("3d ago");
  });
});

// ─── computeKpiData ────────────────────────────────────────────────────────

function makeInv(overrides: Partial<InvestigationSummary>): InvestigationSummary {
  return {
    id: "inv_1",
    service: "svc-a",
    status: "complete",
    report: null,
    created_at: new Date().toISOString(),
    completed_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_duration_ms: 0,
    ...overrides,
  };
}

describe("computeKpiData", () => {
  const NOW = new Date("2025-06-01T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns zeros for empty investigations", () => {
    const result = computeKpiData([], []);
    expect(result.total).toBe(0);
    expect(result.active).toBe(0);
    expect(result.complete).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.totalServices).toBe(0);
    expect(result.healthyCount).toBe(0);
    expect(result.criticalCount).toBe(0);
    expect(result.degradedCount).toBe(0);
    expect(result.avgMttr7d).toBe(0);
    expect(result.mttrTrend).toBeUndefined();
    expect(result.completedLast7dCount).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.totalInput).toBe(0);
    expect(result.totalOutput).toBe(0);
  });

  it("counts investigation statuses correctly", () => {
    const investigations = [
      makeInv({ id: "1", status: "complete" }),
      makeInv({ id: "2", status: "complete" }),
      makeInv({ id: "3", status: "running" }),
      makeInv({ id: "4", status: "failed" }),
    ];
    const result = computeKpiData(investigations, []);
    expect(result.total).toBe(4);
    expect(result.complete).toBe(2);
    expect(result.active).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("calculates service health from latest investigation per service", () => {
    const services = [{ name: "svc-a" }, { name: "svc-b" }, { name: "svc-c" }];

    // svc-a: latest is failed (critical)
    // svc-b: latest is running (degraded)
    // svc-c: latest is complete (healthy)
    const older = new Date(NOW - 2 * 60 * 60_000).toISOString(); // 2h ago
    const newer = new Date(NOW - 1 * 60 * 60_000).toISOString(); // 1h ago

    const investigations = [
      makeInv({ id: "1", service: "svc-a", status: "complete", created_at: older }),
      makeInv({ id: "2", service: "svc-a", status: "failed", created_at: newer }),
      makeInv({ id: "3", service: "svc-b", status: "running", created_at: newer }),
      makeInv({ id: "4", service: "svc-c", status: "complete", created_at: newer }),
    ];

    const result = computeKpiData(investigations, services);
    expect(result.totalServices).toBe(3);
    expect(result.criticalCount).toBe(1);
    expect(result.degradedCount).toBe(1);
    expect(result.healthyCount).toBe(1);
  });

  it("returns 0 avgMttr7d when no completed investigations in last 7d", () => {
    // Completed investigation older than 7 days
    const eightDaysAgo = new Date(NOW - 8 * 24 * 60 * 60_000).toISOString();
    const investigations = [
      makeInv({ id: "1", status: "complete", total_duration_ms: 60_000, created_at: eightDaysAgo }),
    ];
    const result = computeKpiData(investigations, []);
    expect(result.avgMttr7d).toBe(0);
    expect(result.completedLast7dCount).toBe(0);
    expect(result.mttrTrend).toBeUndefined();
  });

  it("calculates MTTR from completed investigations in last 7 days", () => {
    const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString();
    const oneDayAgo = new Date(NOW - 1 * 24 * 60 * 60_000).toISOString();
    const investigations = [
      makeInv({ id: "1", status: "complete", total_duration_ms: 60_000, created_at: threeDaysAgo }),
      makeInv({ id: "2", status: "complete", total_duration_ms: 120_000, created_at: oneDayAgo }),
    ];
    const result = computeKpiData(investigations, []);
    // avg of 60_000 and 120_000 = 90_000
    expect(result.avgMttr7d).toBe(90_000);
    expect(result.completedLast7dCount).toBe(2);
  });

  it("shows downward trend when MTTR improved (current < prior)", () => {
    // Last 7d: avg = 60_000 ms
    // Prior 7d (8-14 days ago): avg = 120_000 ms
    // pctChange = (60_000 - 120_000) / 120_000 * 100 = -50%
    const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString();
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60_000).toISOString();

    const investigations = [
      makeInv({ id: "1", status: "complete", total_duration_ms: 60_000, created_at: threeDaysAgo }),
      makeInv({ id: "2", status: "complete", total_duration_ms: 120_000, created_at: tenDaysAgo }),
    ];

    const result = computeKpiData(investigations, []);
    expect(result.mttrTrend).toBeDefined();
    expect(result.mttrTrend?.direction).toBe("down");
    expect(result.mttrTrend?.value).toBe("50%");
    expect(result.mttrTrend?.positive).toBe(true);
  });

  it("shows upward trend when MTTR regressed (current > prior)", () => {
    // Last 7d: avg = 120_000 ms
    // Prior 7d: avg = 60_000 ms
    // pctChange = (120_000 - 60_000) / 60_000 * 100 = 100%
    const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString();
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60_000).toISOString();

    const investigations = [
      makeInv({ id: "1", status: "complete", total_duration_ms: 120_000, created_at: threeDaysAgo }),
      makeInv({ id: "2", status: "complete", total_duration_ms: 60_000, created_at: tenDaysAgo }),
    ];

    const result = computeKpiData(investigations, []);
    expect(result.mttrTrend).toBeDefined();
    expect(result.mttrTrend?.direction).toBe("up");
    expect(result.mttrTrend?.value).toBe("100%");
    expect(result.mttrTrend?.positive).toBe(false);
  });

  it("shows no trend when only one period has data", () => {
    // Only last 7d data, no prior 7d data
    const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString();
    const investigations = [
      makeInv({ id: "1", status: "complete", total_duration_ms: 60_000, created_at: threeDaysAgo }),
    ];
    const result = computeKpiData(investigations, []);
    expect(result.avgMttr7d).toBe(60_000);
    expect(result.mttrTrend).toBeUndefined();
  });

  it("aggregates token usage correctly", () => {
    const investigations = [
      makeInv({ id: "1", total_input_tokens: 100, total_output_tokens: 200 }),
      makeInv({ id: "2", total_input_tokens: 300, total_output_tokens: 400 }),
      makeInv({ id: "3", total_input_tokens: 0, total_output_tokens: 0 }),
    ];
    const result = computeKpiData(investigations, []);
    expect(result.totalInput).toBe(400);
    expect(result.totalOutput).toBe(600);
    expect(result.totalTokens).toBe(1000);
  });
});

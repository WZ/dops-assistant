import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { severityVariant, formatDuration, normalizeConfidence, timeAgo } from "./dashboard-utils.js";

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

// computeKpiData removed — KPIs are now computed server-side via GET /api/stats/kpi
// Tests for the server-side computation are in src/server/db.test.ts

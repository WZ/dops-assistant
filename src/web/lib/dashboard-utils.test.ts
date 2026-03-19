import { describe, expect, it } from "vitest";
import { severityVariant, formatDuration, normalizeConfidence } from "./dashboard-utils.js";

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

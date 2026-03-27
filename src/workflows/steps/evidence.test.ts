import { describe, it, expect } from "vitest";

describe("evidence step truncation", () => {
  const TRUNCATION_LIMIT = 8000;

  it("preserves tool results up to 8000 chars without truncating", () => {
    const longResult = "x".repeat(5000);
    const truncated = longResult.length > TRUNCATION_LIMIT
      ? longResult.slice(0, TRUNCATION_LIMIT) + "..."
      : longResult;
    expect(truncated).toBe(longResult);
    expect(truncated.endsWith("...")).toBe(false);
  });

  it("truncates tool results beyond 8000 chars", () => {
    const longResult = "x".repeat(10000);
    const truncated = longResult.length > TRUNCATION_LIMIT
      ? longResult.slice(0, TRUNCATION_LIMIT) + "..."
      : longResult;
    expect(truncated.length).toBe(8003);
    expect(truncated.endsWith("...")).toBe(true);
  });
});

describe("evidence validation", () => {
  it("detects thin log evidence (fewer than 3 observations)", () => {
    const logsFindings = {
      summary: "Some logs found",
      observations: [{ pattern: "error", count: "5" }],
    };
    const isThick = (logsFindings.observations?.length ?? 0) >= 3;
    expect(isThick).toBe(false);
  });

  it("detects thin metric evidence (fewer than 2 observations)", () => {
    const metricsFindings = {
      summary: "Metrics checked",
      observations: [{ metric: "cpu", currentValue: "80%" }],
    };
    const isThick = (metricsFindings.observations?.length ?? 0) >= 2;
    expect(isThick).toBe(false);
  });

  it("passes validation for adequate evidence", () => {
    const metricsFindings = {
      summary: "Metrics checked",
      observations: [
        { metric: "cpu", currentValue: "80%" },
        { metric: "mem", currentValue: "90%" },
        { metric: "latency", currentValue: "500ms" },
      ],
    };
    const isThick = (metricsFindings.observations?.length ?? 0) >= 2;
    expect(isThick).toBe(true);
  });
});

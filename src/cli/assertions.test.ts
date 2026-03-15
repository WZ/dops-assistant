// src/cli/assertions.test.ts
import { describe, it, expect } from "vitest";
import { evaluateAssertions, getNestedValue } from "./assertions.js";

describe("getNestedValue", () => {
  it("gets top-level field", () => {
    expect(getNestedValue({ status: "success" }, "status")).toBe("success");
  });

  it("gets nested field", () => {
    expect(getNestedValue({ result: { severity: "high" } }, "result.severity")).toBe("high");
  });

  it("gets deeply nested field", () => {
    const obj = { result: { evidence: { metrics: ["cpu > 90%"] } } };
    expect(getNestedValue(obj, "result.evidence.metrics")).toEqual(["cpu > 90%"]);
  });

  it("returns undefined for missing field", () => {
    expect(getNestedValue({ a: 1 }, "b")).toBeUndefined();
  });
});

describe("evaluateAssertions", () => {
  const data = {
    status: "success",
    result: {
      severity: "high",
      confidenceScore: 0.85,
      evidence: { metrics: ["cpu spike"], logs: [], infra: [] },
      summary: "High CPU due to memory leak",
    },
  };

  it("evaluates literal match", () => {
    const results = evaluateAssertions(data, { status: "success" });
    expect(results[0]).toEqual({ field: "status", expected: "success", actual: "success", pass: true });
  });

  it("evaluates 'in' operator", () => {
    const results = evaluateAssertions(data, { "result.severity": { in: ["high", "critical"] } });
    expect(results[0]!.pass).toBe(true);
  });

  it("fails 'in' operator when not in set", () => {
    const results = evaluateAssertions(data, { "result.severity": { in: ["low"] } });
    expect(results[0]!.pass).toBe(false);
  });

  it("evaluates 'gte' operator", () => {
    const results = evaluateAssertions(data, { "result.confidenceScore": { gte: 0.5 } });
    expect(results[0]!.pass).toBe(true);
  });

  it("evaluates 'lte' operator", () => {
    const results = evaluateAssertions(data, { "result.confidenceScore": { lte: 1.0 } });
    expect(results[0]!.pass).toBe(true);
  });

  it("evaluates 'not_empty' operator on array", () => {
    const results = evaluateAssertions(data, { "result.evidence.metrics": { not_empty: true } });
    expect(results[0]!.pass).toBe(true);
  });

  it("fails 'not_empty' on empty array", () => {
    const results = evaluateAssertions(data, { "result.evidence.logs": { not_empty: true } });
    expect(results[0]!.pass).toBe(false);
  });

  it("evaluates 'contains' operator", () => {
    const results = evaluateAssertions(data, { "result.summary": { contains: "memory leak" } });
    expect(results[0]!.pass).toBe(true);
  });

  it("fails 'contains' when substring not found", () => {
    const results = evaluateAssertions(data, { "result.summary": { contains: "disk full" } });
    expect(results[0]!.pass).toBe(false);
  });

  it("evaluates multiple assertions", () => {
    const results = evaluateAssertions(data, {
      status: "success",
      "result.severity": { in: ["high", "critical"] },
      "result.confidenceScore": { gte: 0.5 },
    });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { validateRules } from "./scan-rule-validator.js";

function goodRule(overrides: Record<string, unknown> = {}) {
  return {
    name: "availability",
    query: 'up{service="{service}"}',
    threshold: { op: "lt", value: 1 },
    consecutiveTicks: 1,
    ...overrides,
  };
}

describe("validateRules — structural", () => {
  it("accepts a valid single rule", () => {
    const r = validateRules([goodRule()]);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.rules).toHaveLength(1);
  });

  it("rejects non-array input", () => {
    const r = validateRules({ name: "x" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.path).toBe("rules");
  });

  it("applies consecutiveTicks default=1 when omitted", () => {
    const r = validateRules([{
      name: "availability",
      query: 'up{service="{service}"}',
      threshold: { op: "lt", value: 1 },
    }]);
    expect(r.ok).toBe(true);
    expect(r.rules[0]!.consecutiveTicks).toBe(1);
  });

  it("rejects empty name", () => {
    const r = validateRules([goodRule({ name: "" })]);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.message.includes("non-empty"))).toBe(true);
  });

  it("rejects empty query", () => {
    const r = validateRules([goodRule({ query: "" })]);
    expect(r.ok).toBe(false);
  });

  it("rejects consecutiveTicks < 1", () => {
    const r = validateRules([goodRule({ consecutiveTicks: 0 })]);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.message.includes(">= 1"))).toBe(true);
  });

  it("rejects non-integer consecutiveTicks", () => {
    const r = validateRules([goodRule({ consecutiveTicks: 1.5 })]);
    expect(r.ok).toBe(false);
  });

  it("rejects unknown threshold op", () => {
    const r = validateRules([goodRule({ threshold: { op: "eq", value: 1 } })]);
    expect(r.ok).toBe(false);
  });

  it("rejects non-numeric threshold value", () => {
    const r = validateRules([goodRule({ threshold: { op: "gt", value: "1" } })]);
    expect(r.ok).toBe(false);
  });

  it("rejects unknown top-level fields (strict mode)", () => {
    const r = validateRules([goodRule({ extra: "surprise" })]);
    expect(r.ok).toBe(false);
  });

  it("accepts empty array (clears all rules — scan becomes a no-op)", () => {
    const r = validateRules([]);
    expect(r.ok).toBe(true);
    expect(r.rules).toEqual([]);
  });
});

describe("validateRules — name uniqueness", () => {
  it("rejects duplicate names", () => {
    const r = validateRules([
      goodRule({ name: "availability" }),
      goodRule({ name: "availability", query: 'rate(foo{service="{service}"}[5m])' }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.message.includes("Duplicate rule name"))).toBe(true);
    expect(r.errors.some(e => e.path === "rules[1].name")).toBe(true);
  });

  it("names differing only in case are considered distinct", () => {
    // We use strict equality — "availability" !== "Availability". Matches
    // how the consecutiveState Map keys work.
    const r = validateRules([
      goodRule({ name: "availability" }),
      goodRule({ name: "Availability" }),
    ]);
    expect(r.ok).toBe(true);
  });
});

describe("validateRules — {service} template check", () => {
  it("rejects a query missing the {service} placeholder", () => {
    const r = validateRules([goodRule({ query: "up" })]);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === "rules[0].query")).toBe(true);
    expect(r.errors.some(e => e.message.includes("{service}"))).toBe(true);
  });

  it("accepts {service} anywhere in the query, not just label selector", () => {
    const r = validateRules([goodRule({ query: 'rate(errors{app="{service}"}[5m])' })]);
    expect(r.ok).toBe(true);
  });
});

describe("validateRules — aggregate error reporting", () => {
  it("collects multiple errors across multiple rules in one pass", () => {
    const r = validateRules([
      goodRule({ name: "good" }),
      goodRule({ name: "bad", query: "up" }), // missing {service}
      goodRule({ name: "bad" }),              // duplicate name
    ]);
    expect(r.ok).toBe(false);
    // At least 2 errors: missing {service} + duplicate name
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

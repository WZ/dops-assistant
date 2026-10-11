import { describe, it, expect } from "vitest";
import { normalizeMetricSeverity, normalizeMetricObservations } from "./metric-severity.js";
import { createMetricsAgent } from "../../agents/metrics.js";

describe("normalizeMetricSeverity", () => {
  it("maps critical-class words to critical", () => {
    for (const v of ["critical", "Critical", " CRITICAL ", "severe", "fatal", "major"]) expect(normalizeMetricSeverity(v)).toBe("critical");
  });

  it("maps elevated words (including the model's 'high' and 'medium') to warning, not critical", () => {
    for (const v of ["warning", "warn", "high", "medium", "elevated", "moderate", "degraded"]) expect(normalizeMetricSeverity(v)).toBe("warning");
  });

  it("maps everything else, including missing values, to normal", () => {
    for (const v of ["normal", "info", "low", "ok", "stable", "", undefined, null, 3]) expect(normalizeMetricSeverity(v)).toBe("normal");
  });
});

describe("normalizeMetricObservations", () => {
  it("rewrites severity and keeps the other fields", () => {
    const out = normalizeMetricObservations([
      { metric: "e2e_latency_p99", currentValue: "424s", severity: "critical" },
      { metric: "completed_requests", currentValue: "0", severity: "high" },
      { metric: "inter_token_latency", currentValue: "25ms", severity: "info" },
    ]);
    expect(out.map((o) => o.severity)).toEqual(["critical", "warning", "normal"]);
    expect(out[0]).toMatchObject({ metric: "e2e_latency_p99", currentValue: "424s" });
  });
});

describe("metrics agent prompt", () => {
  it("defines the severity vocabulary, says latency alone is never critical, and asks for the PromQL", async () => {
    const agent = createMetricsAgent({ model: {} as never, tools: {} });
    const instructions = String(await (agent as unknown as { getInstructions: () => unknown }).getInstructions());
    expect(instructions).toContain('exactly one of: "normal", "warning", "critical"');
    expect(instructions).toContain("Latency alone is never \"critical\"");
    expect(instructions).toContain("EXACT PromQL expression");
    expect(instructions).not.toMatch(/severity >=\s*medium/);
  });
});

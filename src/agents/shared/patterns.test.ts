import { describe, it, expect } from "vitest";
import { formatPatterns, type IncidentPatternRow } from "./patterns.js";

const row = (overrides: Partial<IncidentPatternRow> = {}): IncidentPatternRow => ({
  id: "pat_01XYZ",
  service: "payments-api",
  symptom: "5xx error rate spiked at 12:00 UTC, lasted 11 min.",
  root_cause: "Upstream payments-worker OOMKilled; no circuit breaker.",
  severity: "high",
  recommended_actions: "Add HPA min replicas; add circuit breaker",
  created_at: "2026-04-21T10:00:00.000Z",
  ...overrides,
});

describe("formatPatterns", () => {
  it("returns empty string for an empty array", () => {
    expect(formatPatterns("payments-api", [])).toBe("");
  });

  it("includes the service name in the header", () => {
    const out = formatPatterns("payments-api", [row()]);
    expect(out.startsWith("Past useful patterns for payments-api:")).toBe(true);
  });

  it("renders id, severity, date, symptom, root cause, actions", () => {
    const out = formatPatterns("payments-api", [row()]);
    expect(out).toContain("[pat_01XYZ — high severity, 2026-04-21]");
    expect(out).toContain("SYMPTOM: 5xx error rate spiked at 12:00 UTC, lasted 11 min.");
    expect(out).toContain("ROOT CAUSE: Upstream payments-worker OOMKilled; no circuit breaker.");
    expect(out).toContain("ACTIONS: Add HPA min replicas; add circuit breaker");
  });

  it("omits the ACTIONS line when recommended_actions is null", () => {
    const out = formatPatterns("payments-api", [row({ recommended_actions: null })]);
    expect(out).not.toContain("ACTIONS:");
    expect(out).toContain("ROOT CAUSE:");
  });

  it("renders multiple patterns separated by blank lines, in input order", () => {
    const out = formatPatterns("payments-api", [
      row({ id: "pat_A", symptom: "first" }),
      row({ id: "pat_B", symptom: "second" }),
    ]);
    const aIdx = out.indexOf("pat_A");
    const bIdx = out.indexOf("pat_B");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    // Two blocks are separated by exactly two newlines
    expect(out).toMatch(/SYMPTOM: first[\s\S]*?\n\n\[pat_B/);
  });

  it("clips symptom and root cause at 500 chars", () => {
    const long = "x".repeat(800);
    const out = formatPatterns("payments-api", [row({ symptom: long, root_cause: long })]);
    // 500 chars + "…" suffix
    expect(out).toContain("x".repeat(500) + "…");
    // Original 800 length must NOT be present in full
    expect(out).not.toContain("x".repeat(501));
  });

  it("falls back to the raw timestamp when created_at is unparseable", () => {
    const out = formatPatterns("payments-api", [row({ created_at: "not-a-date" })]);
    expect(out).toContain("not-a-date");
  });
});

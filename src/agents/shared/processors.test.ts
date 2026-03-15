import { describe, it, expect } from "vitest";
import { safeJsonParse } from "./processors.js";

describe("safeJsonParse", () => {
  it("parses valid JSON directly", () => {
    const result = safeJsonParse('{"isAnomaly":true,"severity":"high"}');
    expect(result).toEqual({ isAnomaly: true, severity: "high" });
  });

  it("extracts JSON from a markdown json code block", () => {
    const text = 'Here is the result:\n```json\n{"summary":"CPU spike","observations":[]}\n```';
    const result = safeJsonParse(text);
    expect(result).toEqual({ summary: "CPU spike", observations: [] });
  });

  it("extracts JSON from a plain markdown code block (no language tag)", () => {
    const text = "Analysis complete:\n```\n{\"rootCause\":\"Memory leak\"}\n```";
    const result = safeJsonParse(text);
    expect(result).toEqual({ rootCause: "Memory leak" });
  });

  it("extracts first JSON object from free-form text", () => {
    const text = 'After analysis I found: {"severity":"medium","summary":"Error spike"} — end of report.';
    const result = safeJsonParse(text);
    expect(result).toEqual({ severity: "medium", summary: "Error spike" });
  });

  it("returns null for pure prose with no JSON", () => {
    const result = safeJsonParse("I cannot determine the root cause.");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(safeJsonParse("")).toBeNull();
  });

  it("returns null for malformed JSON with no valid fallback", () => {
    expect(safeJsonParse("{broken: json}")).toBeNull();
  });

  it("parses JSON with nested objects", () => {
    const text = JSON.stringify({
      hypotheses: [{ hypothesis: "DB overload", evidenceNeeded: "slow query logs" }],
      metricFocus: ["latency"],
      logFocus: ["db errors"],
      infraFocus: [],
    });
    const result = safeJsonParse(text);
    expect(result?.hypotheses).toHaveLength(1);
    expect(result?.hypotheses[0].hypothesis).toBe("DB overload");
    expect(result?.metricFocus).toEqual(["latency"]);
  });

  it("prefers direct parse over code block extraction when text is valid JSON", () => {
    const valid = '{"key":"value"}';
    expect(safeJsonParse(valid)).toEqual({ key: "value" });
  });
});

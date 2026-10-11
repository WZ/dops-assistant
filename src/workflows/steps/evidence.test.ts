import { describe, it, expect } from "vitest";
import { TOOL_RESULT_TRUNCATION_LIMIT } from "../../constants.js";
import { capToolDataForExtraction, recoverFromToolData } from "./evidence.js";

describe("evidence step truncation", () => {
  const TRUNCATION_LIMIT = TOOL_RESULT_TRUNCATION_LIMIT;

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

describe("capToolDataForExtraction", () => {
  it("keeps every entry when they fit", () => {
    expect(capToolDataForExtraction(["Tool: a\nResult: 1", "Tool: b\nResult: 2"], 1000)).toBe("Tool: a\nResult: 1\n\nTool: b\nResult: 2");
  });

  it("drops the oldest entries first when over the cap, keeping order", () => {
    const entries = ["Tool: old\n" + "o".repeat(300), "Tool: mid\n" + "m".repeat(300), "Tool: new\n" + "n".repeat(300)];
    const out = capToolDataForExtraction(entries, 700);
    expect(out).not.toContain("Tool: old");
    expect(out.indexOf("Tool: mid")).toBeLessThan(out.indexOf("Tool: new"));
    expect(out.length).toBeLessThanOrEqual(700);
  });

  it("truncates a single entry larger than the cap instead of dropping it", () => {
    expect(capToolDataForExtraction(["Tool: big\n" + "x".repeat(5000)], 100)).toHaveLength(100);
  });
});

describe("recoverFromToolData", () => {
  const schemaOutput = JSON.stringify({ summary: "recovered", observations: [{ pattern: "p", count: "3" }] });

  it("extracts observations from captured tool results", async () => {
    const extract = async (input: string) => (input.includes("Tool: query_loki_logs") ? schemaOutput : "{}");
    const out = await recoverFromToolData(["Tool: query_loki_logs\nResult: lines"], extract);
    expect(out?.observations).toHaveLength(1);
    expect(out?.summary).toBe("recovered");
  });

  it("does nothing without tool results, only model text", async () => {
    const extract = async () => schemaOutput;
    expect(await recoverFromToolData(["Model: thinking out loud"], extract)).toBeNull();
    expect(await recoverFromToolData([], extract)).toBeNull();
  });

  it("returns null when the extractor throws or yields no observations", async () => {
    expect(await recoverFromToolData(["Tool: a\nResult: x"], async () => { throw new Error("context too long"); })).toBeNull();
    expect(await recoverFromToolData(["Tool: a\nResult: x"], async () => '{"summary":"s","observations":[]}')).toBeNull();
    expect(await recoverFromToolData(["Tool: a\nResult: x"], async () => "not json")).toBeNull();
  });
});

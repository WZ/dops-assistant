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

  it("extracts the LAST JSON object from mixed natural language + JSON text", () => {
    // Simulates the common case: agent writes analysis with embedded JSON snippets,
    // then ends with the structured output JSON as instructed.
    const text = [
      'I analyzed the infrastructure. The pod had {"status": "Running"} which is normal.',
      'Events showed {"reason": "Killing", "count": 1} for the deployment.',
      'Based on my analysis, here is the structured result:',
      '{"summary": "Pod was killed and recreated", "observations": [{"resource": "pod", "status": "Killing", "detail": "Deployment recreated at 08:22"}]}',
    ].join("\n");
    const result = safeJsonParse(text);
    expect(result).not.toBeNull();
    expect(result.summary).toBe("Pod was killed and recreated");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].resource).toBe("pod");
  });

  it("ignores small inline JSON snippets that aren't structured output", () => {
    // Small inline {key: value} fragments are noise, not structured output
    const text = 'The config uses {"a": 1} settings.';
    const result = safeJsonParse(text);
    expect(result).toBeNull();
  });

  // Regression: in-prod discover LLM produced a JSON array with JS-style
  // block comments like `/* StatefulSets */` as section dividers. JSON.parse
  // rejected it and the entire discovery result was silently dropped.
  it("parses a JSON array with JSONC block comments between elements", () => {
    const text = `[
      {"name": "a"},
      /* StatefulSets */
      {"name": "b"},
      /* DaemonSets */
      {"name": "c"}
    ]`;
    const result = safeJsonParse(text);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("a");
    expect(result[2].name).toBe("c");
  });

  it("parses a JSON array with // line comments", () => {
    const text = `[
      {"name": "a"}, // first
      {"name": "b"}  // second
    ]`;
    const result = safeJsonParse(text);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("parses a JSON array wrapped in a markdown code block with comments", () => {
    const text = '```json\n[\n  {"name": "a"},\n  /* group */\n  {"name": "b"}\n]\n```';
    const result = safeJsonParse(text);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("tolerates trailing commas in arrays and objects", () => {
    const text = '[{"a": 1,}, {"b": 2,},]';
    const result = safeJsonParse(text);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].a).toBe(1);
    expect(result[1].b).toBe(2);
  });

  it("does NOT corrupt strings that contain comment-like sequences", () => {
    const text = '{"description": "see /* important */ docs", "url": "https://foo/bar"}';
    const result = safeJsonParse(text);
    expect(result.description).toBe("see /* important */ docs");
    expect(result.url).toBe("https://foo/bar");
  });

  it("extracts a top-level JSON array even with preamble text", () => {
    const text = 'Here is the result:\n[{"a": 1}, {"b": 2}]\nDone.';
    const result = safeJsonParse(text);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("recovers a truncated JSON array by finding the last complete object", () => {
    const text = '[{"name":"svc-a","metrics":[]},{"name":"svc-b","metrics":[]},{"name":"svc-c","met';
    const result = safeJsonParse(text);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("svc-a");
    expect(result[1].name).toBe("svc-b");
  });

  it("recovers a truncated array with prose preamble", () => {
    const text = 'Here are the discovered services:\n[{"name":"a"},{"name":"b"},{"na';
    const result = safeJsonParse(text);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("returns null for non-JSON text (no truncation recovery possible)", () => {
    const result = safeJsonParse("This is just plain text with no JSON at all.");
    expect(result).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { parseMetricHints } from "./metric-extraction.js";

describe("parseMetricHints", () => {
  it("extracts cpu keyword", () => {
    const hints = parseMetricHints("CPU usage spiked to 94% at 14:32");
    expect(hints.keywords).toContain("cpu");
  });

  it("extracts memory keyword", () => {
    const hints = parseMetricHints("Memory consumption reached 512Mi");
    expect(hints.keywords).toContain("memory");
  });

  it("extracts multiple keywords", () => {
    const hints = parseMetricHints("Latency increased and error rate spiked");
    expect(hints.keywords).toContain("latency");
    expect(hints.keywords).toContain("error");
  });

  it("extracts time reference", () => {
    const hints = parseMetricHints("CPU spiked at 14:32");
    expect(hints.timeRef).toBe("14:32");
  });

  it("extracts time range", () => {
    const hints = parseMetricHints("Between 14:00 and 15:30 error rate was elevated");
    expect(hints.timeRef).toBe("14:00");
    expect(hints.timeRefEnd).toBe("15:30");
  });

  it("returns empty keywords for unrelated text", () => {
    const hints = parseMetricHints("The service was restarted");
    expect(hints.keywords).toEqual([]);
  });

  it("handles empty string gracefully", () => {
    const hints = parseMetricHints("");
    expect(hints.keywords).toEqual([]);
    expect(hints.timeRef).toBeUndefined();
  });
});

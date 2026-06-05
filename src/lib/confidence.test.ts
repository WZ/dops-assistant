import { describe, it, expect } from "vitest";
import { confidenceFraction, confidencePercent } from "./confidence.js";

describe("confidenceFraction", () => {
  it("passes 0–1 fractions through", () => {
    expect(confidenceFraction(0.9)).toBeCloseTo(0.9);
    expect(confidenceFraction(0.42)).toBeCloseTo(0.42);
    expect(confidenceFraction(1)).toBe(1);
    expect(confidenceFraction(0)).toBe(0);
  });

  it("rescales 0–100 values to a fraction", () => {
    expect(confidenceFraction(90)).toBeCloseTo(0.9);
    expect(confidenceFraction(95)).toBeCloseTo(0.95);
    expect(confidenceFraction(95.0)).toBeCloseTo(0.95);
  });

  it("clamps to [0, 1] and handles bad input", () => {
    expect(confidenceFraction(9000)).toBe(1); // pathological — clamp, don't emit 90x
    expect(confidenceFraction(-5)).toBe(0);
    expect(confidenceFraction(null)).toBe(0);
    expect(confidenceFraction(undefined)).toBe(0);
    expect(confidenceFraction(NaN)).toBe(0);
  });
});

describe("confidencePercent", () => {
  it("renders both scales as the same percentage (no more 9000%)", () => {
    expect(confidencePercent(0.9)).toBe(90);
    expect(confidencePercent(90)).toBe(90); // the bug: was 9000
    expect(confidencePercent(0.95)).toBe(95);
    expect(confidencePercent(95)).toBe(95);
    expect(confidencePercent(null)).toBe(0);
  });
});

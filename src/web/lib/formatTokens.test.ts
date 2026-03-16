import { describe, it, expect } from "vitest";
import { formatTokens } from "./formatTokens.js";

describe("formatTokens", () => {
  it("returns literal number for < 1000", () => {
    expect(formatTokens(892)).toBe("892");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(18200)).toBe("18.2k");
    expect(formatTokens(54717)).toBe("54.7k");
    expect(formatTokens(999999)).toBe("1000.0k");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(1234567)).toBe("1.2M");
  });
});

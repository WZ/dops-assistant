import { describe, it, expect } from "vitest";
import { severityRank, ALL_SOURCES, ALL_SEVERITIES } from "./notifications.js";

describe("severityRank", () => {
  it("orders severities low < medium < high < critical", () => {
    expect(severityRank("low")).toBeLessThan(severityRank("medium"));
    expect(severityRank("medium")).toBeLessThan(severityRank("high"));
    expect(severityRank("high")).toBeLessThan(severityRank("critical"));
  });

  it("is monotonic with ALL_SEVERITIES order", () => {
    for (let i = 1; i < ALL_SEVERITIES.length; i++) {
      expect(severityRank(ALL_SEVERITIES[i]!)).toBeGreaterThan(severityRank(ALL_SEVERITIES[i - 1]!));
    }
  });

  it("ALL_SOURCES contains exactly the five sources", () => {
    expect([...ALL_SOURCES].sort()).toEqual(["manual", "poller", "scan", "scan-run", "webhook"]);
  });
});

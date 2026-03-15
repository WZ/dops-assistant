import { describe, it, expect } from "vitest";
import { extractDashboardPanelHints, extractQueryKeywords } from "./prefetch.js";

describe("extractDashboardPanelHints", () => {
  it("extracts hints from parenthetical pattern", () => {
    const result = extractDashboardPanelHints("(Ingestion Log Rate in Ingestion monitor)");
    expect(result.panelHint).toBe("Ingestion Log Rate");
    expect(result.dashboardHint).toBe("Ingestion monitor");
  });

  it("extracts hints from non-paren pattern with dashboard/monitor suffix", () => {
    const result = extractDashboardPanelHints("Check Error Rate in Service Dashboard please");
    expect(result.panelHint).toBe("Check Error Rate");
    expect(result.dashboardHint).toBe("Service Dashboard");
  });

  it("returns nulls when no hints found", () => {
    const result = extractDashboardPanelHints("investigate the ingestion server");
    expect(result.panelHint).toBeNull();
    expect(result.dashboardHint).toBeNull();
  });

  it("handles undefined inputs", () => {
    const result = extractDashboardPanelHints(undefined, undefined);
    expect(result.panelHint).toBeNull();
    expect(result.dashboardHint).toBeNull();
  });

  it("extracts from anomalySummary when userMessage is empty", () => {
    const result = extractDashboardPanelHints(undefined, "(Request Rate in API Overview)");
    expect(result.panelHint).toBe("Request Rate");
    expect(result.dashboardHint).toBe("API Overview");
  });

  it("prefers userMessage over anomalySummary when both contain patterns", () => {
    // Both match but userMessage comes first in the concatenated text
    const result = extractDashboardPanelHints("(Panel A in Dashboard A)", "(Panel B in Dashboard B)");
    expect(result.panelHint).toBe("Panel A");
    expect(result.dashboardHint).toBe("Dashboard A");
  });

  it("extracts 'overview' suffix pattern", () => {
    const result = extractDashboardPanelHints("Error Rate in Payments Overview");
    expect(result.panelHint).toBe("Error Rate");
    expect(result.dashboardHint).toBe("Payments Overview");
  });
});

describe("extractQueryKeywords", () => {
  it("extracts words of 4+ characters", () => {
    const keywords = extractQueryKeywords("check the error rate for payments");
    expect(keywords).toContain("check");
    expect(keywords).toContain("error");
    expect(keywords).toContain("rate");
    expect(keywords).toContain("payments");
    // Short words filtered out
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("for");
  });

  it("lowercases all keywords", () => {
    const keywords = extractQueryKeywords("High Error Rate in PAYMENTS");
    expect(keywords).toContain("high");
    expect(keywords).toContain("error");
    expect(keywords).toContain("rate");
    expect(keywords).toContain("payments");
  });

  it("handles undefined inputs", () => {
    const keywords = extractQueryKeywords(undefined, undefined);
    expect(keywords).toEqual([]);
  });

  it("combines userMessage and anomalySummary", () => {
    const keywords = extractQueryKeywords("ingestion server", "high latency detected");
    expect(keywords).toContain("ingestion");
    expect(keywords).toContain("server");
    expect(keywords).toContain("high");
    expect(keywords).toContain("latency");
    expect(keywords).toContain("detected");
  });

  it("filters numbers and tokens under 4 chars", () => {
    const keywords = extractQueryKeywords("api 200 err 500 rate");
    // "api" is 3 chars — filtered out
    expect(keywords).not.toContain("api");
    expect(keywords).not.toContain("err");
    // "rate" is 4 chars — kept
    expect(keywords).toContain("rate");
    // Numbers alone: "200" is 3 chars — filtered; "500" is 3 chars — filtered
    expect(keywords).not.toContain("200");
  });

  it("handles special characters as delimiters", () => {
    const keywords = extractQueryKeywords("error-rate_high/latency");
    expect(keywords).toContain("error");
    expect(keywords).toContain("rate");
    expect(keywords).toContain("high");
    expect(keywords).toContain("latency");
  });
});

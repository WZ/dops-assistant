import { describe, it, expect } from "vitest";
import { scanRunToMarkdown } from "./exportScanRun.js";

describe("scanRunToMarkdown", () => {
  it("renders a run with zero investigations", () => {
    const md = scanRunToMarkdown(
      { id: "r1", trigger: "cron", status: "complete", startedAt: 1700000000000, servicesProbed: 117, hitsDispatched: 0, durationMs: 2300 },
      [],
    );
    expect(md).toContain("# Scan Run r1");
    expect(md).toContain("117");
    expect(md).toContain("No investigations dispatched");
  });

  it("renders a run with multiple investigations", () => {
    const md = scanRunToMarkdown(
      { id: "r1", trigger: "manual", status: "complete", startedAt: 0, servicesProbed: 10, hitsDispatched: 2, durationMs: 500 },
      [
        { investigationId: "inv1", service: "api", ruleName: "availability", status: "complete", reportSummary: "DB pool exhausted" },
        { investigationId: "inv2", service: "auth", ruleName: "error_rate", status: "running", reportSummary: null },
      ],
    );
    expect(md).toContain("inv1");
    expect(md).toContain("DB pool exhausted");
    expect(md).toContain("auth");
    expect(md).toContain("running");
  });

  it("includes started timestamp in ISO format", () => {
    const md = scanRunToMarkdown(
      { id: "r1", trigger: "cron", status: "complete", startedAt: 1700000000000, servicesProbed: 10, hitsDispatched: 0, durationMs: 100 },
      [],
    );
    // Date.prototype.toISOString() should appear; check for the year prefix
    expect(md).toMatch(/202\d-\d\d-\d\dT/);
  });

  it("omits duration when durationMs is null", () => {
    const md = scanRunToMarkdown(
      { id: "r1", trigger: "cron", status: "running", startedAt: 0, servicesProbed: 10, hitsDispatched: 0, durationMs: null },
      [],
    );
    expect(md).not.toContain("Duration");
  });
});

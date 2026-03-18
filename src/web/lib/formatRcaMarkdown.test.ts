import { describe, it, expect } from "vitest";
import { formatRcaMarkdown } from "./formatRcaMarkdown.js";
import type { RcaReport } from "../../types/rca-types.js";

const FULL_REPORT: RcaReport = {
  service: "checkout-service",
  severity: "high",
  summary: "Memory leak caused OOM kills",
  impact: { duration: "45m", description: "50% of requests failed" },
  rootCause: "Unbounded cache in payment processor",
  trigger: "Traffic spike from flash sale",
  contributingFactors: ["No memory limits set", "Cache has no TTL"],
  timeline: [
    { time: "2026-03-18T10:00:00Z", event: "Traffic spike began" },
    { time: "2026-03-18T10:15:00Z", event: "First OOMKill" },
  ],
  evidence: {
    metrics: ["Memory usage grew linearly from 500MB to 4GB"],
    logs: ["java.lang.OutOfMemoryError at PaymentCache.put()"],
    infra: ["Pod checkout-abc123 OOMKilled 3 times"],
    changes: ["Deploy v2.3.1 at 09:45 added cache-all flag"],
  },
  dashboardLinks: ["https://grafana.example.com/d/checkout"],
  recommendedActions: ["Set memory limits", "Add cache TTL"],
  confidence: "high",
  confidenceScore: 0.92,
  investigatedAt: "2026-03-18T10:30:00Z",
};

describe("formatRcaMarkdown", () => {
  it("includes all report sections", () => {
    const md = formatRcaMarkdown(FULL_REPORT);
    expect(md).toContain("# RCA Report: checkout-service");
    expect(md).toContain("**Severity:** high");
    expect(md).toContain("## Root Cause");
    expect(md).toContain("Unbounded cache");
    expect(md).toContain("## Timeline");
    expect(md).toContain("Traffic spike began");
    expect(md).toContain("## Contributing Factors");
    expect(md).toContain("No memory limits set");
    expect(md).toContain("## Evidence");
    expect(md).toContain("### Recent Changes");
    expect(md).toContain("Deploy v2.3.1");
    expect(md).toContain("## Recommended Actions");
    expect(md).toContain("1. Set memory limits");
  });

  it("handles minimal report", () => {
    const minimal: RcaReport = {
      service: "test",
      severity: "low",
      summary: "Nothing happened",
      impact: { duration: "0", description: "" },
      rootCause: "Unknown",
      trigger: "Unknown",
      contributingFactors: [],
      timeline: [],
      evidence: { metrics: [], logs: [], infra: [] },
      dashboardLinks: [],
      recommendedActions: [],
      confidence: "low",
      confidenceScore: 0.1,
      investigatedAt: "2026-01-01T00:00:00Z",
    };
    const md = formatRcaMarkdown(minimal);
    expect(md).toContain("# RCA Report: test");
    expect(md).not.toContain("## Timeline");
    expect(md).not.toContain("## Contributing Factors");
  });
});

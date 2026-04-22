import { describe, it, expect } from "vitest";
import type { RcaReport } from "../../types/rca-types.js";
import { renderSubject, renderBody, renderTextFallback, SEVERITY_COLORS } from "./investigation-notification.js";

const fullReport: RcaReport = {
  service: "checkout-service",
  severity: "critical",
  summary: "Availability dropped to 41% after deploy of build abc123 at 14:22 UTC",
  impact: { duration: "6m 12s", description: "~40% of checkout requests failing with 503" },
  trigger: "Availability rule fired after 3 consecutive sub-95% ticks",
  rootCause: "New build introduced a misconfigured DB pool; saturation at baseline traffic",
  contributingFactors: ["No canary stage", "Pool sizing not load-tested"],
  timeline: [
    { time: "14:22", event: "Deploy abc123 rolled out" },
    { time: "14:26", event: "Error rate spiked past 10%" },
    { time: "14:28", event: "Scan triggered investigation" },
  ],
  evidence: {
    metrics: ["availability=0.41 (baseline 0.995)"],
    logs: ["connection pool exhausted; 2041 errors in 2m"],
    infra: ["pod restarts normal"],
    changes: ["deploy abc123 at 14:22 by buildbot"],
  },
  dashboardLinks: ["https://grafana.example.com/d/checkout"],
  recommendedActions: ["Roll back abc123", "Increase pool size"],
  confidence: "high",
  confidenceScore: 78,
  investigatedAt: "2026-04-22T14:28:00Z",
  skillsUsed: ["intent", "metrics", "synthesis"],
  timeRange: { from: "2026-04-22T14:00:00Z", to: "2026-04-22T14:30:00Z" },
};

const minimalReport: RcaReport = {
  ...fullReport,
  severity: "low",
  evidence: { metrics: [], logs: [], infra: [] },
};
delete (minimalReport as Partial<RcaReport>).skillsUsed;
delete (minimalReport as Partial<RcaReport>).timeRange;

describe("renderSubject", () => {
  it("uppercases severity, includes service, truncates summary", () => {
    const subject = renderSubject(fullReport);
    expect(subject.startsWith("[CRITICAL] checkout-service: ")).toBe(true);
    expect(subject.length).toBeLessThanOrEqual(80);
  });

  it("does not truncate short summaries", () => {
    const s = renderSubject({ ...fullReport, summary: "short" });
    expect(s).toBe("[CRITICAL] checkout-service: short");
  });

  it("truncates long summaries with ellipsis", () => {
    const longSummary = "a".repeat(100);
    const s = renderSubject({ ...fullReport, summary: longSummary });
    expect(s.endsWith("…") || s.endsWith("...")).toBe(true);
  });
});

describe("renderBody", () => {
  it("contains every section for a full report", () => {
    const html = renderBody(fullReport, "inv_123", "https://dops.example.com/", "scan");
    expect(html).toContain("checkout-service");
    expect(html).toContain("CRITICAL");
    expect(html).toContain("Proactive scan");
    expect(html).toContain("Investigated 2026-04-22");
    expect(html).toContain("Window");
    expect(html).toContain(fullReport.summary);
    expect(html).toContain(fullReport.impact.description);
    expect(html).toContain(fullReport.impact.duration);
    expect(html).toContain(fullReport.trigger);
    expect(html).toContain(fullReport.rootCause);
    expect(html).toContain("78");
    for (const f of fullReport.contributingFactors) expect(html).toContain(f);
    for (const t of fullReport.timeline) { expect(html).toContain(t.time); expect(html).toContain(t.event); }
    for (const m of fullReport.evidence.metrics) expect(html).toContain(m);
    for (const l of fullReport.evidence.logs) expect(html).toContain(l);
    for (const i of fullReport.evidence.infra) expect(html).toContain(i);
    for (const c of fullReport.evidence.changes!) expect(html).toContain(c);
    for (const a of fullReport.recommendedActions) expect(html).toContain(a);
    for (const d of fullReport.dashboardLinks) expect(html).toContain(d);
    expect(html).toContain("https://dops.example.com/investigations/inv_123");
    expect(html).toContain("intent, metrics, synthesis");
  });

  it("omits optional sections for a minimal report", () => {
    const html = renderBody(minimalReport, "inv_456", "https://dops.example.com/", "webhook");
    expect(html).not.toContain("Skills used:");
    expect(html).not.toContain("Window");
    expect(html).not.toContain("Changes");
    expect(html).toContain("Alertmanager webhook");
  });

  it("uses the correct severity banner color", () => {
    const html = renderBody(fullReport, "inv_1", "https://x/", "scan");
    expect(html).toContain(SEVERITY_COLORS.critical);
    const low = renderBody(minimalReport, "inv_2", "https://x/", "scan");
    expect(low).toContain(SEVERITY_COLORS.low);
  });

  it("uses inline styles only (no style blocks, no external CSS)", () => {
    const html = renderBody(fullReport, "inv_1", "https://x/", "scan");
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/<link\b/i);
  });

  it("escapes HTML in report fields", () => {
    const r = { ...fullReport, summary: "oops <script>alert(1)</script>" };
    const html = renderBody(r, "inv_1", "https://x/", "scan");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("builds absolute investigation URL from appBaseUrl with or without trailing slash", () => {
    const withSlash = renderBody(fullReport, "inv_1", "https://dops.example.com/", "scan");
    const withoutSlash = renderBody(fullReport, "inv_1", "https://dops.example.com", "scan");
    expect(withSlash).toContain("https://dops.example.com/investigations/inv_1");
    expect(withoutSlash).toContain("https://dops.example.com/investigations/inv_1");
  });

  it("neutralizes non-http hrefs in dashboard links", () => {
    const r = { ...fullReport, dashboardLinks: ["javascript:alert(1)", "https://grafana.example.com/d/ok"] };
    const html = renderBody(r, "inv_1", "https://x/", "scan");
    // The visible text is still shown (escaped)
    expect(html).toContain("javascript:alert(1)");
    // But the href for the bad entry is neutralized to "#"
    expect(html).toMatch(/<a href="#"[^>]*>javascript:alert\(1\)<\/a>/);
    // And the good URL still works
    expect(html).toMatch(/<a href="https:\/\/grafana\.example\.com\/d\/ok"[^>]*>https:\/\/grafana\.example\.com\/d\/ok<\/a>/);
  });
});

describe("renderTextFallback", () => {
  it("contains plain-text equivalents of all sections", () => {
    const text = renderTextFallback(fullReport, "inv_123", "https://dops.example.com/", "scan");
    expect(text).toContain("[CRITICAL] checkout-service");
    expect(text).toContain("Proactive scan");
    expect(text).toContain(fullReport.summary);
    expect(text).toContain(fullReport.rootCause);
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
    expect(text).toContain("https://dops.example.com/investigations/inv_123");
  });
});

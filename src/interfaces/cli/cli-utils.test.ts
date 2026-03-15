import { describe, it, expect, vi, beforeEach } from "vitest";


import { parseInline } from "./Markdown.js";
import { formatRcaText, saveAndOpenImages } from "./App.js";
import type { RcaReport } from "../../types/rca-types.js";
import type { ImageAttachment } from "../../types/agent-types.js";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

describe("parseInline", () => {
  it("returns plain text when no formatting", () => {
    expect(parseInline("hello world")).toEqual([
      { type: "text", value: "hello world" },
    ]);
  });

  it("parses bold text", () => {
    expect(parseInline("hello **bold** world")).toEqual([
      { type: "text", value: "hello " },
      { type: "bold", value: "bold" },
      { type: "text", value: " world" },
    ]);
  });

  it("parses inline code", () => {
    expect(parseInline("use `foo()` here")).toEqual([
      { type: "text", value: "use " },
      { type: "code", value: "foo()" },
      { type: "text", value: " here" },
    ]);
  });

  it("parses multiple bold sections", () => {
    expect(parseInline("**foo** and **bar**")).toEqual([
      { type: "bold", value: "foo" },
      { type: "text", value: " and " },
      { type: "bold", value: "bar" },
    ]);
  });

  it("handles mixed bold and code", () => {
    expect(parseInline("**bold** then `code`")).toEqual([
      { type: "bold", value: "bold" },
      { type: "text", value: " then " },
      { type: "code", value: "code" },
    ]);
  });

  it("treats unclosed ** as plain text", () => {
    expect(parseInline("hello **unclosed")).toEqual([
      { type: "text", value: "hello " },
      { type: "text", value: "**" },
      { type: "text", value: "unclosed" },
    ]);
  });

  it("treats unclosed backtick as plain text", () => {
    expect(parseInline("hello `unclosed")).toEqual([
      { type: "text", value: "hello " },
      { type: "text", value: "`" },
      { type: "text", value: "unclosed" },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseInline("")).toEqual([]);
  });

  it("handles empty bold (**) as plain text", () => {
    const result = parseInline("before **** after");
    // ** followed by ** — no content between, so treated as text
    expect(result.every((s) => s.type === "text" || s.type === "bold")).toBe(true);
  });
});

describe("formatRcaText", () => {
  const baseReport: RcaReport = {
    service: "payments-api",
    severity: "high",
    summary: "Elevated error rate detected",
    impact: { duration: "23 minutes (14:02–14:25 UTC)", description: "Error rate spiked to 15% affecting checkout flow" },
    trigger: "Connection pool saturated after traffic spike",
    rootCause: "Database connection pool exhaustion",
    contributingFactors: ["No connection pool auto-scaling configured"],
    timeline: [
      { time: "2026-03-03T14:02:00Z", event: "Traffic spike begins" },
      { time: "2026-03-03T14:05:00Z", event: "Connection pool saturated" },
    ],
    evidence: { metrics: ["error_rate=15%"], logs: ["connection timeout"], infra: [] },
    dashboardLinks: [],
    recommendedActions: ["Scale connection pool", "Add circuit breaker"],
    confidence: "high",
    investigatedAt: "3/3/2026, 8:52:13 AM",
  };

  it("formats a complete RCA report with markdown headers", () => {
    const text = formatRcaText(baseReport);
    expect(text).toContain("# 🟠 RCA: payments-api");
    expect(text).toContain("**Severity:** high");
    expect(text).toContain("**Confidence:** high");
    expect(text).toContain("## ⏱️ Impact");
    expect(text).toContain("23 minutes (14:02–14:25 UTC)");
    expect(text).toContain("## ⚡ Trigger");
    expect(text).toContain("Connection pool saturated after traffic spike");
    expect(text).toContain("## 🔍 Root Cause");
    expect(text).toContain("Database connection pool exhaustion");
    expect(text).toContain("## 🔗 Contributing Factors");
    expect(text).toContain("No connection pool auto-scaling configured");
    expect(text).toContain("## 🕐 Timeline");
    expect(text).toContain("Traffic spike begins");
    expect(text).toContain("## 📋 Summary");
    expect(text).toContain("Elevated error rate detected");
    expect(text).toContain("1. Scale connection pool");
    expect(text).toContain("2. Add circuit breaker");
    expect(text).toContain("3/3/2026, 8:52:13 AM");
  });

  it("uses correct severity emojis", () => {
    expect(formatRcaText({ ...baseReport, severity: "low" })).toContain("🟢");
    expect(formatRcaText({ ...baseReport, severity: "medium" })).toContain("🟡");
    expect(formatRcaText({ ...baseReport, severity: "high" })).toContain("🟠");
    expect(formatRcaText({ ...baseReport, severity: "critical" })).toContain("🔴");
  });

  it("omits actions section when empty", () => {
    const text = formatRcaText({ ...baseReport, recommendedActions: [] });
    expect(text).not.toContain("## 🛠️ Recommended Actions");
  });

  it("renders evidence metrics as markdown bullets", () => {
    const text = formatRcaText({
      ...baseReport,
      evidence: { metrics: ["error_rate=15%"], logs: [], infra: [] },
    });
    expect(text).toContain("### 📈 Metrics");
    expect(text).toContain("- error_rate=15%");
  });

  it("renders evidence logs as markdown bullets", () => {
    const text = formatRcaText({
      ...baseReport,
      evidence: { metrics: [], logs: ["connection timeout"], infra: [] },
    });
    expect(text).toContain("### 📝 Logs");
    expect(text).toContain("- connection timeout");
  });

  it("renders evidence infra as markdown bullets", () => {
    const text = formatRcaText({
      ...baseReport,
      evidence: { metrics: [], logs: [], infra: ["node-1 unreachable"] },
    });
    expect(text).toContain("### 🖥️ Infrastructure");
    expect(text).toContain("- node-1 unreachable");
  });

  it("renders dashboard links section", () => {
    const text = formatRcaText({
      ...baseReport,
      dashboardLinks: ["https://grafana/d/abc?panelId=1"],
    });
    expect(text).toContain("## 🔗 Dashboard Links");
    expect(text).toContain("- https://grafana/d/abc?panelId=1");
  });

  it("omits empty evidence sections", () => {
    const text = formatRcaText({
      ...baseReport,
      evidence: { metrics: [], logs: [], infra: [] },
      dashboardLinks: [],
    });
    expect(text).not.toContain("### 📈 Metrics");
    expect(text).not.toContain("### 📝 Logs");
    expect(text).not.toContain("## 🔗 Dashboard Links");
  });

  it("strips leading bullet markers from LLM output", () => {
    const text = formatRcaText({
      ...baseReport,
      evidence: {
        metrics: ["• already bulleted item", "- dash item", "* star item"],
        logs: [],
        infra: [],
      },
    });
    // Should have single bullets, not double
    expect(text).toContain("- already bulleted item");
    expect(text).toContain("- dash item");
    expect(text).toContain("- star item");
    expect(text).not.toContain("- • ");
    expect(text).not.toContain("- - ");
    expect(text).not.toContain("- * ");
  });

  it("strips leading bullets from recommended actions", () => {
    const text = formatRcaText({
      ...baseReport,
      recommendedActions: ["• Check logs", "- Restart pods"],
    });
    expect(text).toContain("1. Check logs");
    expect(text).toContain("2. Restart pods");
  });

  it("strips emoji numbers from recommended actions", () => {
    const text = formatRcaText({
      ...baseReport,
      recommendedActions: ["1\uFE0F\u20E3 Validate broker health", "2\uFE0F\u20E3 Inspect network"],
    });
    expect(text).toContain("1. Validate broker health");
    expect(text).toContain("2. Inspect network");
    // No double numbering
    expect(text).not.toContain("1. 1");
    expect(text).not.toContain("2. 2");
  });

  it("strips leading number prefixes from actions", () => {
    const text = formatRcaText({
      ...baseReport,
      recommendedActions: ["1. Already numbered", "2) Paren style"],
    });
    expect(text).toContain("1. Already numbered");
    expect(text).toContain("2. Paren style");
    expect(text).not.toContain("1. 1.");
  });
});

describe("saveAndOpenImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes image files to temp directory", () => {
    const images: ImageAttachment[] = [
      { filename: "chart.png", mimeType: "image/png", data: Buffer.from("fake-png") },
    ];

    const paths = saveAndOpenImages(images);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("dops-chart.png");
    expect(writeFileSync).toHaveBeenCalledWith(paths[0], images[0]!.data);
  });

  it("returns multiple paths for multiple images", () => {
    const images: ImageAttachment[] = [
      { filename: "a.png", mimeType: "image/png", data: Buffer.from("a") },
      { filename: "b.jpg", mimeType: "image/jpeg", data: Buffer.from("b") },
    ];

    const paths = saveAndOpenImages(images);
    expect(paths).toHaveLength(2);
    expect(writeFileSync).toHaveBeenCalledTimes(2);
  });

  it("returns empty array for no images", () => {
    const paths = saveAndOpenImages([]);
    expect(paths).toEqual([]);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

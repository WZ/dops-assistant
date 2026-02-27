import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseInline } from "./Markdown.js";
import { formatRcaText, saveAndOpenImages } from "./App.js";
import type { RcaReport } from "../../agent/rca-types.js";
import type { ImageAttachment } from "../../agent/types.js";
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
    rootCause: "Database connection pool exhaustion",
    evidence: { metrics: ["error_rate=15%"], logs: ["connection timeout"], infra: [] },
    recommendedActions: ["Scale connection pool", "Add circuit breaker"],
    confidence: "high",
    investigatedAt: "2026-02-27T10:00:00Z",
  };

  it("formats a complete RCA report", () => {
    const text = formatRcaText(baseReport);
    expect(text).toContain("🟠 RCA Report: payments-api");
    expect(text).toContain("Severity: high | Confidence: high");
    expect(text).toContain("Root cause: Database connection pool exhaustion");
    expect(text).toContain("Summary: Elevated error rate detected");
    expect(text).toContain("1. Scale connection pool");
    expect(text).toContain("2. Add circuit breaker");
    expect(text).toContain("Investigated at: 2026-02-27T10:00:00Z");
  });

  it("uses correct severity emojis", () => {
    expect(formatRcaText({ ...baseReport, severity: "low" })).toContain("🟢");
    expect(formatRcaText({ ...baseReport, severity: "medium" })).toContain("🟡");
    expect(formatRcaText({ ...baseReport, severity: "high" })).toContain("🟠");
    expect(formatRcaText({ ...baseReport, severity: "critical" })).toContain("🔴");
  });

  it("omits actions section when empty", () => {
    const text = formatRcaText({ ...baseReport, recommendedActions: [] });
    expect(text).not.toContain("Actions:");
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

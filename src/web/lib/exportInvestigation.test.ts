// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { safeName, downloadMarkdown } from "./exportInvestigation";
import type { RcaReport } from "../../types/rca-types.js";

vi.mock("html-to-image", () => ({ toPng: vi.fn() }));

describe("safeName", () => {
  it("passes alphanumeric service names through unchanged", () => {
    expect(safeName("ingestion-server")).toBe("ingestion-server");
    expect(safeName("cluster_autoscaler")).toBe("cluster_autoscaler");
  });

  it("lowercases uppercase characters", () => {
    expect(safeName("Ingestion-Server")).toBe("ingestion-server");
  });

  it("replaces special characters with dashes", () => {
    expect(safeName("svc.with/slashes:and spaces")).toBe("svc-with-slashes-and-spaces");
  });

  it("falls back to 'investigation' for empty or all-special input", () => {
    expect(safeName("")).toBe("investigation");
    expect(safeName("!!!")).toBe("---");
  });

  it("strips unicode", () => {
    expect(safeName("svc-日本語")).toBe("svc----");
  });
});

describe("downloadMarkdown", () => {
  const report = {
    service: "ingestion-server",
    severity: "high",
    confidence: "high",
    confidenceScore: 0.87,
    investigatedAt: "2026-04-15T07:00:00Z",
    summary: "Pod OOMKilled due to memory leak",
    rootCause: "leaked subscription",
    trigger: "deploy at 06:59",
    impact: { duration: "2m", description: "50% error rate" },
    contributingFactors: ["no heap limit"],
    timeline: [{ time: "06:59", event: "deploy" }],
    recommendedActions: ["add heap cap"],
    dashboardLinks: [],
  } as RcaReport;

  let createdAnchor: HTMLAnchorElement | null = null;
  // Capture the real createElement once at module load, before any spying.
  const realCreate = document.createElement.bind(document);

  beforeEach(() => {
    createdAnchor = null;
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = realCreate(tag);
      if (tag === "a") {
        createdAnchor = el as HTMLAnchorElement;
        vi.spyOn(el as HTMLAnchorElement, "click").mockImplementation(() => {});
      }
      return el;
    }) as typeof document.createElement);

    global.URL.createObjectURL = vi.fn(() => "blob:mock");
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("triggers a download with a safe filename + .md extension", () => {
    downloadMarkdown(report, "ingestion-server");
    expect(createdAnchor).not.toBeNull();
    expect(createdAnchor!.download).toMatch(/^rca-ingestion-server-\d+\.md$/);
    expect(createdAnchor!.href).toBe("blob:mock");
  });

  it("sanitizes the service name in the filename", () => {
    downloadMarkdown(report, "Svc With/Slashes");
    expect(createdAnchor!.download).toMatch(/^rca-svc-with-slashes-\d+\.md$/);
  });

  it("revokes the object URL after download", () => {
    downloadMarkdown(report, "ingestion-server");
    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });
});

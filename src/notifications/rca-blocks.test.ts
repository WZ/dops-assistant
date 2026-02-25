import { describe, it, expect } from "vitest";
import { formatRcaBlocks } from "./rca-blocks.js";
import type { RcaReport } from "../agent/rca-types.js";

const report: RcaReport = {
  service: "payments-api",
  severity: "high",
  summary: "High error rate detected",
  rootCause: "DB connection pool exhausted",
  evidence: {
    metrics: ["error_rate: 18% at 14:32 UTC"],
    logs: ["connection timeout after 30s (340x)"],
    infra: ["pod restarted 3x (OOMKilled)"],
  },
  recommendedActions: ["Scale connection pool", "Restart pods"],
  confidence: "high",
  investigatedAt: "2026-02-25T14:37:00.000Z",
};

describe("formatRcaBlocks", () => {
  it("includes service name and severity in header", () => {
    const blocks = formatRcaBlocks(report);
    const header = blocks.find((b) => b.type === "header");
    expect(JSON.stringify(header)).toContain("payments-api");
    expect(JSON.stringify(header)).toContain("high");
  });

  it("includes root cause section", () => {
    const blocks = formatRcaBlocks(report);
    const text = JSON.stringify(blocks);
    expect(text).toContain("DB connection pool exhausted");
  });

  it("includes all evidence types", () => {
    const blocks = formatRcaBlocks(report);
    const text = JSON.stringify(blocks);
    expect(text).toContain("error_rate: 18%");
    expect(text).toContain("connection timeout");
    expect(text).toContain("pod restarted");
  });

  it("includes recommended actions", () => {
    const blocks = formatRcaBlocks(report);
    const text = JSON.stringify(blocks);
    expect(text).toContain("Scale connection pool");
    expect(text).toContain("Restart pods");
  });

  it("includes confidence and timestamp", () => {
    const blocks = formatRcaBlocks(report);
    const text = JSON.stringify(blocks);
    expect(text).toContain("high");
    expect(text).toContain("14:37");
  });

  it("omits empty evidence sections", () => {
    const sparseReport: RcaReport = {
      ...report,
      evidence: { metrics: ["metric: 18%"], logs: [], infra: [] },
    };
    const blocks = formatRcaBlocks(sparseReport);
    const text = JSON.stringify(blocks);
    expect(text).not.toContain("Logs");
    expect(text).not.toContain("Infrastructure");
  });
});

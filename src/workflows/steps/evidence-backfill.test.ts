import { describe, it, expect } from "vitest";
import { backfillEmptyEvidence } from "./evidence-backfill.js";

const empty = { metrics: [], logs: [], infra: [], changes: [] };

describe("backfillEmptyEvidence", () => {
  it("fills an empty category from that phase's observations", () => {
    const out = backfillEmptyEvidence(empty, {
      metrics: { observations: [{ metric: "vllm:e2e_latency_p99", currentValue: "1.8", severity: "warning" }] },
      logs: { observations: [{ pattern: "CUDA OOM", sampleLines: ["oom at layer 12"], firstSeen: "2026-10-10T07:00:00Z" }] },
      infra: { observations: ["Pod/x Running"] },
    });
    expect(out.metrics).toEqual(["vllm:e2e_latency_p99 = 1.8 (warning)"]);
    expect(out.logs).toEqual(["[2026-10-10T07:00:00Z] CUDA OOM: oom at layer 12"]);
    expect(out.infra).toEqual(["Pod/x Running"]);
    expect(out.changes).toEqual([]);
  });

  it("never overrides evidence the model already wrote", () => {
    const out = backfillEmptyEvidence(
      { ...empty, metrics: ["model wrote this"] },
      { metrics: { observations: [{ metric: "m", currentValue: 1 }] } },
    );
    expect(out.metrics).toEqual(["model wrote this"]);
  });

  it("caps entries per category and truncates long lines", () => {
    const out = backfillEmptyEvidence(empty, {
      logs: { observations: Array.from({ length: 25 }, (_, i) => `line ${i} ${"x".repeat(400)}`) },
    });
    expect(out.logs).toHaveLength(10);
    expect(out.logs[0]!.length).toBeLessThanOrEqual(300);
  });

  it("leaves categories empty when there are no usable observations", () => {
    const out = backfillEmptyEvidence(empty, { metrics: { observations: [{}] }, logs: {} });
    expect(out).toEqual(empty);
  });
});

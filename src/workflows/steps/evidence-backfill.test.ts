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

  it("tops up a category the model cut to well under half of what was gathered", () => {
    // Observed run: 6 log observations gathered, 1 kept in the report.
    const observations = ["A", "B", "C", "D", "E", "F"].map((p) => ({ pattern: `pattern ${p}`, sampleLines: [`line ${p}`] }));
    const out = backfillEmptyEvidence(
      { ...empty, logs: ["pattern A appeared 12 times, all INFO"] },
      { logs: { observations } },
    );
    expect(out.logs[0]).toBe("pattern A appeared 12 times, all INFO");
    expect(out.logs).toEqual([
      "pattern A appeared 12 times, all INFO",
      "pattern B: line B", "pattern C: line C", "pattern D: line D", "pattern E: line E", "pattern F: line F",
    ]);
  });

  it("leaves a category alone when the model kept at least half of what was gathered", () => {
    const out = backfillEmptyEvidence(
      { ...empty, logs: ["a", "b", "c"] },
      { logs: { observations: ["one", "two", "three", "four", "five", "six"] } },
    );
    expect(out.logs).toEqual(["a", "b", "c"]);
  });

  it("never adds an observation the kept items already cover", () => {
    const out = backfillEmptyEvidence(
      { ...empty, logs: ["Kafka StreamThread heartbeat seen 686 times, all healthy"] },
      { logs: { observations: ["Kafka StreamThread heartbeat", "other one", "third one", "fourth one"].map((pattern) => ({ pattern, sampleLines: ["x"] })) } },
    );
    expect(out.logs.filter((l) => l.includes("StreamThread"))).toHaveLength(1);
    expect(out.logs).toHaveLength(4);
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

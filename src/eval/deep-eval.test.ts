import { describe, it, expect } from "vitest";
import { scoreRun, scoreRuns, scoreRunGroundTruth, scoreRunsGroundTruth, type IncidentLabel } from "./deep-eval.js";

const consulLabel: IncidentLabel = {
  service: "impala",
  infraType: "consul",
  expectedCauseKeywords: ["consul", "health check"],
  wrongCausePatterns: ["kubernetes", "scaled to zero", "0 replicas"],
  acceptableInconclusive: ["wall-clock", "operator-pause"],
};

const k8sLabel: IncidentLabel = {
  service: "vllm-bench",
  infraType: "k8s",
  expectedCauseKeywords: ["scaled to zero", "0 replicas", "not running", "cleaned up"],
  wrongCausePatterns: ["consul", "gpu", "readiness probe"],
  acceptableInconclusive: ["wall-clock"],
};

describe("scoreRun", () => {
  it("marks a confirmed correct Consul cause as correct", () => {
    const s = scoreRun({ service: "impala", outcome: "confirmed", rootCause: "impala is a bare-metal Consul service with failing health checks" }, consulLabel);
    expect(s.verdict).toBe("correct");
    expect(s.categoryError).toBe(false);
  });

  it("flags a k8s cause for a Consul service as confident-wrong + category-error", () => {
    const s = scoreRun({ service: "impala", outcome: "confirmed", rootCause: "impala is a Kubernetes Deployment scaled to zero replicas" }, consulLabel);
    expect(s.verdict).toBe("confident-wrong");
    expect(s.categoryError).toBe(true);
    expect(s.matchedWrongPattern).toBeTruthy();
  });

  it("flags a fabricated GPU cause for a scaled-to-zero k8s service as confident-wrong (not category-error)", () => {
    const s = scoreRun({ service: "vllm-bench", outcome: "confirmed", rootCause: "GPU resource exhaustion or CUDA error causing degradation" }, k8sLabel);
    expect(s.verdict).toBe("confident-wrong");
    expect(s.matchedWrongPattern).toBe("gpu");
    expect(s.categoryError).toBe(false); // gpu is a fabrication, not a cross-type term
  });

  it("accepts the 'not running / cleaned up' family as correct for a scaled-to-zero k8s service", () => {
    const s = scoreRun({ service: "vllm-bench", outcome: "confirmed", rootCause: "Benchmark job was never created or was cleaned up after completion" }, k8sLabel);
    expect(s.verdict).toBe("correct");
  });

  it("treats a wall-clock as honest-inconclusive when listed acceptable", () => {
    const s = scoreRun({ service: "impala", outcome: "wall-clock", rootCause: null }, consulLabel);
    expect(s.verdict).toBe("honest-inconclusive");
  });

  it("treats an unlisted non-confirmed outcome as unexpected-inconclusive", () => {
    const s = scoreRun({ service: "impala", outcome: "error", rootCause: null }, consulLabel);
    expect(s.verdict).toBe("unexpected-inconclusive");
  });

  it("marks a run with no label as unlabeled", () => {
    const s = scoreRun({ service: "unknown-svc", outcome: "confirmed", rootCause: "anything" }, undefined);
    expect(s.verdict).toBe("unlabeled");
  });

  it("a confirmed cause with no expected keyword is confident-wrong even without a wrong pattern", () => {
    const s = scoreRun({ service: "vllm-bench", outcome: "confirmed", rootCause: "network partition between regions" }, k8sLabel);
    expect(s.verdict).toBe("confident-wrong");
    expect(s.matchedWrongPattern).toBeNull();
  });
});

describe("scoreRuns aggregate", () => {
  it("computes rates and per-service breakdown over a mixed batch", () => {
    const runs = [
      { service: "impala", outcome: "confirmed", rootCause: "Consul health check failing" }, // correct
      { service: "impala", outcome: "wall-clock", rootCause: null }, // honest
      { service: "impala", outcome: "confirmed", rootCause: "Kubernetes Deployment scaled to zero" }, // confident-wrong + cat-error
      { service: "vllm-bench", outcome: "confirmed", rootCause: "deployment scaled to zero, 0 replicas" }, // correct
      { service: "vllm-bench", outcome: "confirmed", rootCause: "GPU resource exhaustion" }, // confident-wrong
    ];
    const card = scoreRuns(runs, [consulLabel, k8sLabel]);
    expect(card.total).toBe(5);
    expect(card.labeled).toBe(5);
    expect(card.correct).toBe(2);
    expect(card.confidentWrong).toBe(2);
    expect(card.categoryError).toBe(1);
    expect(card.honestInconclusive).toBe(1);
    expect(card.correctRate).toBe(40);
    expect(card.confidentWrongRate).toBe(40);
    expect(card.perService["impala"]).toEqual({ runs: 3, correct: 1, confidentWrong: 1 });
    expect(card.perService["vllm-bench"]).toEqual({ runs: 2, correct: 1, confidentWrong: 1 });
  });

  it("zero labeled runs → 0 rates, not NaN", () => {
    const card = scoreRuns([{ service: "ghost", outcome: "confirmed", rootCause: "x" }], [consulLabel]);
    expect(card.labeled).toBe(0);
    expect(card.correctRate).toBe(0);
    expect(card.confidentWrongRate).toBe(0);
  });
});

describe("ground-truth-anchored scoring (F2)", () => {
  it("confirm on a HEALTHY service = false-confirm (the false-PASS the keyword scorer missed)", () => {
    expect(scoreRunGroundTruth({ service: "impala", outcome: "confirmed", rootCause: "data plane failure" }, "healthy").verdict).toBe("false-confirm");
  });
  it("confirm on an UNHEALTHY service = correct-confirm", () => {
    expect(scoreRunGroundTruth({ service: "bd", outcome: "confirmed", rootCause: "consul critical" }, "unhealthy").verdict).toBe("correct-confirm");
  });
  it("decline on a HEALTHY service = correct-decline", () => {
    expect(scoreRunGroundTruth({ service: "kudu", outcome: "wall-clock", rootCause: null }, "healthy").verdict).toBe("correct-decline");
  });
  it("decline on an UNHEALTHY service = missed-incident", () => {
    expect(scoreRunGroundTruth({ service: "bd", outcome: "wall-clock", rootCause: null }, "unhealthy").verdict).toBe("missed-incident");
  });
  it("unknown ground truth = unknown (not scored either way)", () => {
    expect(scoreRunGroundTruth({ service: "x", outcome: "confirmed", rootCause: "y" }, "unknown").verdict).toBe("unknown");
  });

  it("aggregate flags false-confirms and missed-incidents (would have caught the false PASS)", () => {
    // Mirrors the real 8-run finding: confirms on healthy services + a missed real incident.
    const runs = [
      { service: "impala", outcome: "confirmed", rootCause: "daemon failing" },        // healthy → false-confirm
      { service: "ingestion", outcome: "confirmed", rootCause: "cpu throttling" },      // healthy → false-confirm
      { service: "bd", outcome: "wall-clock", rootCause: null },                        // unhealthy → missed
      { service: "kudu", outcome: "wall-clock", rootCause: null },                      // healthy → correct-decline
    ];
    const gt = { impala: "healthy", ingestion: "healthy", bd: "unhealthy", kudu: "healthy" } as const;
    const g = scoreRunsGroundTruth(runs, gt);
    expect(g.falseConfirm).toBe(2);
    expect(g.missedIncident).toBe(1);
    expect(g.correctDecline).toBe(1);
    expect(g.correctConfirm).toBe(0);
  });
});

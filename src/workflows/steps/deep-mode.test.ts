import { describe, it, expect, vi } from "vitest";
import { runDeepMode, matchRuledOutToPredictions, widenTimeRange } from "./deep-mode.js";
import type { RankedHypothesis, NormalizedObservation, Verdict } from "./corroboration.js";

const hyp = (text: string, value: number): RankedHypothesis => ({
  hypothesis: text,
  prediction: { kind: "metric-threshold", metric: "http_p99", op: ">", value },
});

const ruled = (h: RankedHypothesis, priorVerdict: Verdict = "absent") => ({ hypothesis: h, priorVerdict });

const metricObs = (value: number): NormalizedObservation => ({ phase: "metrics", subject: "http_p99", value });

describe("runDeepMode", () => {
  it("resurrects a ruled-out hypothesis when deeper evidence satisfies its prediction", async () => {
    const h = hyp("latency breached SLO", 5);
    // Prior evidence had nothing on http_p99 → loop ruled it out (absent).
    // Deep re-query finds http_p99 = 8 → now satisfied.
    const gatherDeepEvidence = vi.fn().mockResolvedValue([metricObs(8)]);

    const r = await runDeepMode({
      ruledOut: [ruled(h, "absent")],
      priorObservations: [],
      maxReexamine: 2,
      gatherDeepEvidence,
    });

    expect(gatherDeepEvidence).toHaveBeenCalledOnce();
    expect(r.outcome).toBe("resurrected-candidate");
    expect(r.resurrected.map((x) => x.hypothesis)).toEqual(["latency breached SLO"]);
    expect(r.reexamined[0]).toMatchObject({ priorVerdict: "absent", deepVerdict: "satisfied", resurrected: true, deepEvidenceCount: 1 });
    expect(r.observations).toContainEqual(metricObs(8));
  });

  it("confirms the rule-out when deeper evidence still does not satisfy", async () => {
    const h = hyp("latency breached SLO", 5);
    // Deep re-query finds http_p99 = 2 (< 5) → contradicted, not resurrected.
    const gatherDeepEvidence = vi.fn().mockResolvedValue([metricObs(2)]);

    const r = await runDeepMode({
      ruledOut: [ruled(h, "weakened")],
      priorObservations: [],
      maxReexamine: 2,
      gatherDeepEvidence,
    });

    expect(r.outcome).toBe("rule-outs-confirmed");
    expect(r.resurrected).toEqual([]);
    expect(r.reexamined[0]).toMatchObject({ deepVerdict: "contradicted", resurrected: false });
  });

  it("caps re-examination at maxReexamine (leader-first)", async () => {
    const targets = [ruled(hyp("a", 5)), ruled(hyp("b", 5)), ruled(hyp("c", 5))];
    const gatherDeepEvidence = vi.fn().mockResolvedValue([]); // no fresh evidence

    const r = await runDeepMode({
      ruledOut: targets,
      priorObservations: [],
      maxReexamine: 2,
      gatherDeepEvidence,
    });

    expect(gatherDeepEvidence).toHaveBeenCalledTimes(2);
    expect(r.reexamined.map((x) => x.hypothesis)).toEqual(["a", "b"]);
  });

  it("returns nothing-to-examine when there are no ruled-out hypotheses", async () => {
    const gatherDeepEvidence = vi.fn().mockResolvedValue([metricObs(9)]);
    const r = await runDeepMode({
      ruledOut: [],
      priorObservations: [metricObs(1)],
      maxReexamine: 3,
      gatherDeepEvidence,
    });
    expect(r.outcome).toBe("nothing-to-examine");
    expect(r.reexamined).toEqual([]);
    expect(gatherDeepEvidence).not.toHaveBeenCalled();
    expect(r.observations).toEqual([metricObs(1)]);
  });

  it("accumulates evidence across hypotheses so later checks see earlier deep queries", async () => {
    // h1 prediction needs http_p99>5; its own deep query returns nothing, but
    // h2's deep query surfaces http_p99=8 — accumulation means a later pass
    // sees it. (Guards the 'evaluate against full accumulated evidence' rule.)
    const h1 = hyp("first", 5);
    const h2 = hyp("second", 5);
    const gatherDeepEvidence = vi.fn()
      .mockResolvedValueOnce([])            // h1: nothing
      .mockResolvedValueOnce([metricObs(8)]); // h2: finds the breach

    const r = await runDeepMode({
      ruledOut: [ruled(h1, "absent"), ruled(h2, "absent")],
      priorObservations: [],
      maxReexamine: 2,
      gatherDeepEvidence,
    });

    // h2 resurrected via its own query; h1 stays absent (its query ran before h2's).
    expect(r.reexamined[0]).toMatchObject({ hypothesis: "first", resurrected: false });
    expect(r.reexamined[1]).toMatchObject({ hypothesis: "second", resurrected: true });
    expect(r.outcome).toBe("resurrected-candidate");
  });
});

describe("matchRuledOutToPredictions", () => {
  const hyps = [
    { hypothesis: "latency breached SLO", prediction: { kind: "metric-threshold", metric: "http_p99", op: ">", value: 5 } },
    { hypothesis: "deploy caused it", prediction: { kind: "change-in-window", withinMinutesBefore: 30 } },
  ];

  it("rejoins ruled-out text with the matching prediction and carries the verdict", () => {
    const out = matchRuledOutToPredictions(hyps, [
      { hypothesis: "latency breached SLO", reason: "contradicted" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].hypothesis.prediction).toMatchObject({ kind: "metric-threshold", metric: "http_p99" });
    expect(out[0].priorVerdict).toBe("contradicted");
  });

  it("drops ruled-out hypotheses with no matching prediction (can't re-test)", () => {
    const out = matchRuledOutToPredictions(hyps, [
      { hypothesis: "something the loop never ranked", reason: "absent" },
    ]);
    expect(out).toEqual([]);
  });

  it("coerces an unrecognized reason string to the 'absent' verdict", () => {
    const out = matchRuledOutToPredictions(hyps, [
      { hypothesis: "deploy caused it", reason: "weakened" }, // not a Verdict literal
    ]);
    expect(out[0].priorVerdict).toBe("absent");
  });
});

describe("widenTimeRange", () => {
  it("expands a parseable window each side by max(duration, 30min)", () => {
    // 1h window → pad = 1h each side → 3h total, centered.
    const w = widenTimeRange({ from: "2026-06-01T12:00:00.000Z", to: "2026-06-01T13:00:00.000Z" })!;
    expect(w.from).toBe("2026-06-01T11:00:00.000Z");
    expect(w.to).toBe("2026-06-01T14:00:00.000Z");
  });

  it("uses a 30-minute floor for tiny windows", () => {
    // 5-min window → pad floored to 30min each side.
    const w = widenTimeRange({ from: "2026-06-01T12:00:00.000Z", to: "2026-06-01T12:05:00.000Z" })!;
    expect(w.from).toBe("2026-06-01T11:30:00.000Z");
    expect(w.to).toBe("2026-06-01T12:35:00.000Z");
  });

  it("passes through non-parseable ranges (e.g. Grafana relative) unchanged", () => {
    const tr = { from: "now-1h", to: "now" };
    expect(widenTimeRange(tr)).toEqual(tr);
  });

  it("passes through undefined", () => {
    expect(widenTimeRange(undefined)).toBeUndefined();
  });
});

import { describe, it, expect, vi } from "vitest";
import { runDeepMode, matchRuledOutToPredictions, buildReexamineTargets, widenTimeRange } from "./deep-mode.js";
import type { RankedHypothesis, NormalizedObservation } from "./corroboration.js";

const hyp = (text: string, value: number): RankedHypothesis => ({
  hypothesis: text,
  prediction: { kind: "metric-threshold", metric: "http_p99", op: ">", value },
});

const ruled = (h: RankedHypothesis, priorVerdict: "absent" | "contradicted" = "absent") =>
  ({ hypothesis: h, priorStanding: "ruled-out" as const, priorVerdict });
const confirmed = (h: RankedHypothesis) =>
  ({ hypothesis: h, priorStanding: "confirmed" as const, priorVerdict: "satisfied" as const });

const metricObs = (value: number): NormalizedObservation => ({ phase: "metrics", subject: "http_p99", value });

describe("runDeepMode — resurrect (ruled-out)", () => {
  it("resurrects a ruled-out hypothesis when deeper evidence satisfies it", async () => {
    const gatherDeepEvidence = vi.fn().mockResolvedValue([metricObs(8)]);
    const r = await runDeepMode({
      targets: [ruled(hyp("latency breached SLO", 5), "absent")],
      priorObservations: [], maxReexamine: 2, gatherDeepEvidence,
    });
    expect(r.outcome).toBe("resurrected-candidate");
    expect(r.resurrected.map((x) => x.hypothesis)).toEqual(["latency breached SLO"]);
    expect(r.reexamined[0]).toMatchObject({ priorStanding: "ruled-out", deepVerdict: "satisfied", flipped: true });
  });

  it("holds when a ruled-out cause still doesn't satisfy under deeper evidence", async () => {
    const gatherDeepEvidence = vi.fn().mockResolvedValue([metricObs(2)]); // < 5
    const r = await runDeepMode({
      targets: [ruled(hyp("latency breached SLO", 5), "contradicted")],
      priorObservations: [], maxReexamine: 2, gatherDeepEvidence,
    });
    expect(r.outcome).toBe("holds");
    expect(r.resurrected).toEqual([]);
    expect(r.reexamined[0]).toMatchObject({ deepVerdict: "contradicted", flipped: false });
  });
});

describe("runDeepMode — refute (confirmed)", () => {
  it("shakes a confirmed cause when deeper evidence no longer supports it", async () => {
    const gatherDeepEvidence = vi.fn().mockResolvedValue([metricObs(2)]); // < 5 → no longer satisfied
    const r = await runDeepMode({
      targets: [confirmed(hyp("payments backpressure", 5))],
      priorObservations: [], maxReexamine: 2, gatherDeepEvidence,
    });
    expect(r.outcome).toBe("confirmation-shaken");
    expect(r.shaken.map((x) => x.hypothesis)).toEqual(["payments backpressure"]);
    expect(r.reexamined[0]).toMatchObject({ priorStanding: "confirmed", deepVerdict: "contradicted", flipped: true });
  });

  it("holds when a confirmed cause survives deeper evidence", async () => {
    const gatherDeepEvidence = vi.fn().mockResolvedValue([metricObs(9)]); // still > 5
    const r = await runDeepMode({
      targets: [confirmed(hyp("payments backpressure", 5))],
      priorObservations: [], maxReexamine: 2, gatherDeepEvidence,
    });
    expect(r.outcome).toBe("holds");
    expect(r.shaken).toEqual([]);
    expect(r.reexamined[0]).toMatchObject({ deepVerdict: "satisfied", flipped: false });
  });
});

describe("runDeepMode — control flow", () => {
  it("caps re-examination at maxReexamine (leader-first)", async () => {
    const gatherDeepEvidence = vi.fn().mockResolvedValue([]);
    const r = await runDeepMode({
      targets: [ruled(hyp("a", 5)), ruled(hyp("b", 5)), ruled(hyp("c", 5))],
      priorObservations: [], maxReexamine: 2, gatherDeepEvidence,
    });
    expect(gatherDeepEvidence).toHaveBeenCalledTimes(2);
    expect(r.reexamined.map((x) => x.hypothesis)).toEqual(["a", "b"]);
  });

  it("returns nothing-to-examine with no targets", async () => {
    const gatherDeepEvidence = vi.fn().mockResolvedValue([metricObs(9)]);
    const r = await runDeepMode({ targets: [], priorObservations: [metricObs(1)], maxReexamine: 3, gatherDeepEvidence });
    expect(r.outcome).toBe("nothing-to-examine");
    expect(gatherDeepEvidence).not.toHaveBeenCalled();
    expect(r.observations).toEqual([metricObs(1)]);
  });

  it("accumulates evidence across targets so later checks see earlier deep queries", async () => {
    const gatherDeepEvidence = vi.fn()
      .mockResolvedValueOnce([])              // first: nothing
      .mockResolvedValueOnce([metricObs(8)]); // second: finds the breach
    const r = await runDeepMode({
      targets: [ruled(hyp("first", 5)), ruled(hyp("second", 5))],
      priorObservations: [], maxReexamine: 2, gatherDeepEvidence,
    });
    expect(r.reexamined[0]).toMatchObject({ hypothesis: "first", flipped: false });
    expect(r.reexamined[1]).toMatchObject({ hypothesis: "second", flipped: true });
    expect(r.outcome).toBe("resurrected-candidate");
  });
});

describe("buildReexamineTargets", () => {
  const hyps = [
    { hypothesis: "A", prediction: { kind: "metric-threshold", metric: "m", op: ">", value: 1 } },
    { hypothesis: "B", prediction: { kind: "log-pattern", pattern: "x" } },
  ];

  it("resurrect mode: builds ruled-out targets when the loop ruled causes out", () => {
    const t = buildReexamineTargets(hyps, [{ hypothesis: "A", reason: "absent" }], "exhausted", 3);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ priorStanding: "ruled-out", priorVerdict: "absent" });
    expect(t[0].hypothesis.hypothesis).toBe("A");
  });

  it("refute mode: re-tests the leader when confirmed with no rule-outs", () => {
    const t = buildReexamineTargets(hyps, [], "confirmed", 3);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ priorStanding: "confirmed", priorVerdict: "satisfied" });
    expect(t[0].hypothesis.hypothesis).toBe("A");
  });

  it("refute mode: re-tests the top 2 when undetermined", () => {
    const t = buildReexamineTargets(hyps, [], "undetermined", 3);
    expect(t.map((x) => x.hypothesis.hypothesis)).toEqual(["A", "B"]);
    expect(t.every((x) => x.priorStanding === "confirmed")).toBe(true);
  });

  it("returns [] for single-pass reports (no hypotheses)", () => {
    expect(buildReexamineTargets([], [], undefined, 3)).toEqual([]);
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

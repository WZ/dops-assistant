import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluateThreshold,
  severityScore,
  runProbe,
  prioritizeHits,
  buildInvestigationMessage,
  type ProbeHit,
} from "./anomaly-probe.js";
import type { ProbeConfig } from "../config/schema.js";
import type { MastraProvider } from "../mcp/provider.js";

// ── getToolsByRole mock ─────────────────────────────────────────────────────
// getToolsByRole reads tool definitions from providers; we mock it at the
// module level so the probe sees a fake tool we control.
let mockTools: Record<string, unknown> = {};
vi.mock("../mcp/provider.js", () => ({
  getToolsByRole: vi.fn(async () => mockTools),
}));

// ── Shared fixtures ─────────────────────────────────────────────────────────

function buildProbe(overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    concurrency: 4,
    queryTimeoutMs: 1000,
    metrics: [
      { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
      { name: "error_rate", query: 'err{service="{service}"}', threshold: { op: "gt", value: 0.01 }, consecutiveTicks: 2 },
    ],
    logs: { enabled: false, window: "15m", errorRateThreshold: 10, consecutiveTicks: 2 },
    ...overrides,
  };
}

const providers: MastraProvider[] = [];

/** Build a fake MCP instant-query response for a numeric value. */
function promResult(value: number): unknown {
  return { data: { result: [{ value: [Date.now() / 1000, String(value)] }] } };
}

/** Empty Prometheus result (no matching series). */
function emptyPromResult(): unknown {
  return { data: { result: [] } };
}

describe("evaluateThreshold", () => {
  it("gt: true when above", () => expect(evaluateThreshold(2, { op: "gt", value: 1 })).toBe(true));
  it("gt: false when equal", () => expect(evaluateThreshold(1, { op: "gt", value: 1 })).toBe(false));
  it("gte: true when equal", () => expect(evaluateThreshold(1, { op: "gte", value: 1 })).toBe(true));
  it("lt: true when below", () => expect(evaluateThreshold(0, { op: "lt", value: 1 })).toBe(true));
  it("lte: true when equal", () => expect(evaluateThreshold(1, { op: "lte", value: 1 })).toBe(true));
  it("NaN never trips gt", () => expect(evaluateThreshold(NaN, { op: "gt", value: 0 })).toBe(false));
  it("NaN never trips lt", () => expect(evaluateThreshold(NaN, { op: "lt", value: 100 })).toBe(false));
  it("Infinity treated as non-finite (no trip)", () => expect(evaluateThreshold(Infinity, { op: "gt", value: 1 })).toBe(false));
});

describe("severityScore", () => {
  it("returns positive excess for gt when tripped", () => {
    expect(severityScore(2, { op: "gt", value: 1 })).toBeGreaterThan(0);
  });
  it("returns 0 or positive for equal (no negative scores)", () => {
    expect(severityScore(1, { op: "gt", value: 1 })).toBeGreaterThanOrEqual(0);
  });
  it("returns positive for lt when value below threshold", () => {
    expect(severityScore(0, { op: "lt", value: 1 })).toBeGreaterThan(0);
  });
  it("handles threshold=0 without division-by-zero", () => {
    expect(Number.isFinite(severityScore(5, { op: "gt", value: 0 }))).toBe(true);
  });
  it("returns 0 for NaN", () => {
    expect(severityScore(NaN, { op: "gt", value: 1 })).toBe(0);
  });
});

describe("runProbe", () => {
  beforeEach(() => {
    mockTools = {};
  });

  it("returns empty when services list is empty", async () => {
    const state = new Map<string, number>();
    const hits = await runProbe({
      services: [], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state,
    });
    expect(hits).toEqual([]);
  });

  it("returns empty when no metric query tool is available", async () => {
    mockTools = {}; // no tools → findMetricQueryTool returns null
    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state,
    });
    expect(hits).toEqual([]);
  });

  it("flags a tripped rule after 1 tick when consecutiveTicks=1", async () => {
    const execute = vi.fn(async () => promResult(0)); // up=0 → availability trips (< 1)
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state,
    });

    const avail = hits.find(h => h.ruleName === "availability");
    expect(avail).toBeDefined();
    expect(avail!.service).toBe("svc-a");
    expect(avail!.value).toBe(0);
    expect(avail!.consecutiveTicks).toBe(1);
  });

  it("does NOT flag when consecutiveTicks=2 and only 1 tick has breached", async () => {
    // error_rate rule has threshold gt 0.01, consecutiveTicks=2. Value 0.5 trips.
    const execute = vi.fn(async (args: unknown) => {
      const expr = (args as { expr: string }).expr;
      if (expr.includes("up")) return promResult(1); // availability healthy
      return promResult(0.5); // error_rate tripped
    });
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state,
    });

    expect(hits).toEqual([]); // hysteresis swallows the first tick
    expect(state.get("svc-a:error_rate")).toBe(1);
  });

  it("flags after 2 consecutive ticks with consecutiveTicks=2", async () => {
    const execute = vi.fn(async (args: unknown) => {
      const expr = (args as { expr: string }).expr;
      return expr.includes("up") ? promResult(1) : promResult(0.5);
    });
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    // Tick 1: should not fire (count=1)
    await runProbe({ services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state });
    expect(state.get("svc-a:error_rate")).toBe(1);

    // Tick 2: should fire
    const hits = await runProbe({ services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state });
    const err = hits.find(h => h.ruleName === "error_rate");
    expect(err).toBeDefined();
    expect(err!.consecutiveTicks).toBe(2);
  });

  it("resets hysteresis on any non-trip including NaN", async () => {
    const state = new Map<string, number>();
    state.set("svc-a:error_rate", 3); // pre-loaded

    // empty result → NaN → not tripped → state should reset
    mockTools = { query_prometheus: { execute: vi.fn(async () => emptyPromResult()) } };
    await runProbe({ services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state });

    expect(state.get("svc-a:error_rate")).toBeUndefined();
  });

  it("continues after a partial failure (one query throws)", async () => {
    let callCount = 0;
    const execute = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("MCP timeout on this query");
      return promResult(0.5); // second query trips error_rate
    });
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    // Use consecutiveTicks=1 so one tick is enough
    const probe = buildProbe({
      metrics: [
        { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
        { name: "error_rate", query: 'err{service="{service}"}', threshold: { op: "gt", value: 0.01 }, consecutiveTicks: 1 },
      ],
    });

    const hits = await runProbe({ services: ["svc-a"], probe, providers, datasourceUid: "uid", consecutiveState: state });
    // first query (availability) threw → no hit
    // second query (error_rate) tripped → hit
    expect(hits.find(h => h.ruleName === "availability")).toBeUndefined();
    expect(hits.find(h => h.ruleName === "error_rate")).toBeDefined();
  });

  it("respects AbortSignal — aborts do not throw, just return empty", async () => {
    const ac = new AbortController();
    ac.abort(); // pre-aborted

    const execute = vi.fn(async () => promResult(0));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a", "svc-b"],
      probe: buildProbe(),
      providers, datasourceUid: "uid",
      signal: ac.signal,
      consecutiveState: state,
    });
    expect(hits).toEqual([]);
    // execute should not have been called meaningfully (or at most returns NaN from aborted path)
  });

  it("substitutes {service} placeholder in query template", async () => {
    const execute = vi.fn(async () => promResult(1));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    await runProbe({
      services: ["payments-api"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state,
    });

    // First call is for availability — expr should have "payments-api" substituted
    const firstCall = execute.mock.calls[0]?.[0] as { expr: string };
    expect(firstCall.expr).toContain("payments-api");
    expect(firstCall.expr).not.toContain("{service}");
  });
});

describe("prioritizeHits", () => {
  const hitA: ProbeHit = { service: "a", ruleName: "error_rate", value: 0.5, query: "q", threshold: { op: "gt", value: 0.01 }, consecutiveTicks: 2, severity: 49 };
  const hitB: ProbeHit = { service: "b", ruleName: "latency_p99", value: 5, query: "q", threshold: { op: "gt", value: 2 }, consecutiveTicks: 1, severity: 1.5 };
  const hitC: ProbeHit = { service: "c", ruleName: "availability", value: 0, query: "q", threshold: { op: "lt", value: 1 }, consecutiveTicks: 1, severity: 1 };

  it("sorts by severity desc", () => {
    const out = prioritizeHits([hitC, hitA, hitB], () => null);
    expect(out.map(h => h.service)).toEqual(["a", "b", "c"]);
  });

  it("tiebreaks by oldest last-investigated (smallest ms first)", () => {
    const tied: ProbeHit[] = [
      { ...hitB, service: "recent" },
      { ...hitB, service: "old" },
    ];
    const lastMap: Record<string, number> = { recent: Date.now(), old: Date.now() - 3_600_000 };
    const out = prioritizeHits(tied, (s) => lastMap[s] ?? null);
    expect(out[0]!.service).toBe("old");
  });

  it("treats services with no prior investigation as oldest (sorted first on ties)", () => {
    const tied: ProbeHit[] = [
      { ...hitB, service: "recent" },
      { ...hitB, service: "never" },
    ];
    const out = prioritizeHits(tied, (s) => s === "recent" ? Date.now() : null);
    expect(out[0]!.service).toBe("never");
  });

  it("collapses multiple rules per service to one hit (highest severity wins)", () => {
    const svcHits: ProbeHit[] = [
      { ...hitA, service: "dup" },
      { ...hitC, service: "dup" },
    ];
    const out = prioritizeHits(svcHits, () => null);
    expect(out).toHaveLength(1);
    expect(out[0]!.ruleName).toBe("error_rate"); // higher severity
  });
});

describe("buildInvestigationMessage", () => {
  it("includes service, rule, value, threshold, and query", () => {
    const hit: ProbeHit = {
      service: "svc-a", ruleName: "error_rate", value: 0.5, query: "rate(errors)",
      threshold: { op: "gt", value: 0.01 }, consecutiveTicks: 2, severity: 49,
    };
    const msg = buildInvestigationMessage(hit);
    expect(msg).toContain("svc-a");
    expect(msg).toContain("error_rate");
    expect(msg).toContain("0.5");
    expect(msg).toContain("0.01");
    expect(msg).toContain("rate(errors)");
    expect(msg).toContain("2 consecutive");
  });
});

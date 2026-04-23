import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluateThreshold,
  severityScore,
  runProbe,
  prioritizeHits,
  buildInvestigationMessage,
  stateKey,
  type ProbeHit,
} from "./anomaly-probe.js";
import type { ProbeConfig, ServiceConfig, ProbeMetricRule } from "../config/schema.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceRegistryStore, RegistryFile } from "../services/registry.js";

// ── getToolsByRole mock ─────────────────────────────────────────────────────
// getToolsByRole reads tool definitions from providers; we mock it at the
// module level so the probe sees a fake tool we control. Also mocked per
// role so log-source tests can supply a separate logs tool.
let mockTools: Record<string, unknown> = {};
let mockLogsTools: Record<string, unknown> = {};
vi.mock("../mcp/provider.js", () => ({
  getToolsByRole: vi.fn(async (_providers: unknown, role: string) => {
    if (role === "logs") return mockLogsTools;
    return mockTools;
  }),
}));

// ── Shared fixtures ─────────────────────────────────────────────────────────

function buildProbe(overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    concurrency: 4,
    queryTimeoutMs: 1000,
    logsQueryTimeoutMs: 10_000,
    metrics: [
      { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1, source: "metrics" },
      { name: "error_rate", query: 'err{service="{service}"}', threshold: { op: "gt", value: 0.01 }, consecutiveTicks: 2, source: "metrics" },
    ],
    logs: { enabled: false, window: "15m", errorRateThreshold: 10, consecutiveTicks: 2 },
    ...overrides,
  };
}

const providers: MastraProvider[] = [];

/**
 * Build a minimal ServiceRegistryStore-shaped mock. Most tests don't care
 * about what the registry returns — they just need `loadAll()` to exist so
 * the probe's atomic-snapshot read doesn't throw. Tests that exercise
 * track-1 globals or track-2/3 per-service rules pass a richer file.
 */
function fakeRegistryStore(file: Partial<RegistryFile> = {}): ServiceRegistryStore {
  const full: RegistryFile = {
    services: file.services ?? [],
    globalProbeRules: file.globalProbeRules ?? [],
  };
  return { loadAll: () => full } as unknown as ServiceRegistryStore;
}

/** Convenience — the two state-key origins the legacy tests rely on. */
const defaultKey = (service: string, ruleName: string) => stateKey(service, "default", ruleName);

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
      services: [], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state, registryStore: fakeRegistryStore(),
    });
    expect(hits).toEqual([]);
  });

  it("returns empty when no metric query tool is available", async () => {
    mockTools = {}; // no tools → findMetricQueryTool returns null
    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state, registryStore: fakeRegistryStore(),
    });
    expect(hits).toEqual([]);
  });

  it("flags a tripped rule after 1 tick when consecutiveTicks=1", async () => {
    const execute = vi.fn(async () => promResult(0)); // up=0 → availability trips (< 1)
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state, registryStore: fakeRegistryStore(),
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
      services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state, registryStore: fakeRegistryStore(),
    });

    expect(hits).toEqual([]); // hysteresis swallows the first tick
    expect(state.get(defaultKey("svc-a", "error_rate"))).toBe(1);
  });

  it("flags after 2 consecutive ticks with consecutiveTicks=2", async () => {
    const execute = vi.fn(async (args: unknown) => {
      const expr = (args as { expr: string }).expr;
      return expr.includes("up") ? promResult(1) : promResult(0.5);
    });
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    // Tick 1: should not fire (count=1)
    await runProbe({ services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state, registryStore: fakeRegistryStore() });
    expect(state.get(defaultKey("svc-a", "error_rate"))).toBe(1);

    // Tick 2: should fire
    const hits = await runProbe({ services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state, registryStore: fakeRegistryStore() });
    const err = hits.find(h => h.ruleName === "error_rate");
    expect(err).toBeDefined();
    expect(err!.consecutiveTicks).toBe(2);
  });

  it("resets hysteresis on any non-trip including NaN", async () => {
    const state = new Map<string, number>();
    state.set(defaultKey("svc-a", "error_rate"), 3); // pre-loaded

    // empty result → NaN → not tripped → state should reset
    mockTools = { query_prometheus: { execute: vi.fn(async () => emptyPromResult()) } };
    await runProbe({ services: ["svc-a"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state, registryStore: fakeRegistryStore() });

    expect(state.get(defaultKey("svc-a", "error_rate"))).toBeUndefined();
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

    const hits = await runProbe({ services: ["svc-a"], probe, providers, datasourceUid: "uid", consecutiveState: state, registryStore: fakeRegistryStore() });
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
      registryStore: fakeRegistryStore(),
    });
    expect(hits).toEqual([]);
    // execute should not have been called meaningfully (or at most returns NaN from aborted path)
  });

  it("substitutes {service} placeholder in query template", async () => {
    const execute = vi.fn(async () => promResult(1));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    await runProbe({
      services: ["payments-api"], probe: buildProbe(), providers, datasourceUid: "uid", consecutiveState: state, registryStore: fakeRegistryStore(),
    });

    // First call is for availability — expr should have "payments-api" substituted
    const firstCall = execute.mock.calls[0]?.[0] as { expr: string };
    expect(firstCall.expr).toContain("payments-api");
    expect(firstCall.expr).not.toContain("{service}");
  });
});

describe("runProbe — per-service overrides", () => {
  beforeEach(() => {
    mockTools = {};
  });

  it("skips disabled services entirely (no queries fired)", async () => {
    const execute = vi.fn(async () => promResult(0));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    await runProbe({
      services: ["svc-a", "svc-b"],
      probe: buildProbe({
        metrics: [
          { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
        ],
      }),
      providers, datasourceUid: "uid",
      consecutiveState: state,
      getOverride: (svc) => svc === "svc-a" ? { disabled: true } : null,
      registryStore: fakeRegistryStore(),
    });

    // Only svc-b should have been probed. Check via expr substitution.
    const calls = execute.mock.calls.map((c) => (c[0] as { expr: string }).expr);
    expect(calls.every((expr) => expr.includes("svc-b"))).toBe(true);
    expect(calls.some((expr) => expr.includes("svc-a"))).toBe(false);
  });

  it("uses override rules instead of globals for a specific service", async () => {
    const execute = vi.fn(async () => promResult(0));
    mockTools = { query_prometheus: { execute } };

    const globalRules = [
      { name: "global-rule", query: 'global_up{service="{service}"}', threshold: { op: "lt" as const, value: 1 }, consecutiveTicks: 1 },
    ];
    const customRules = [
      { name: "custom-rule", query: 'custom_up{service="{service}"}', threshold: { op: "lt" as const, value: 1 }, consecutiveTicks: 1 },
    ];

    const state = new Map<string, number>();
    await runProbe({
      services: ["svc-a", "svc-b"],
      probe: buildProbe({ metrics: globalRules }),
      providers, datasourceUid: "uid",
      consecutiveState: state,
      getOverride: (svc) => svc === "svc-a" ? { rules: customRules } : null,
      registryStore: fakeRegistryStore(),
    });

    const calls = execute.mock.calls.map((c) => (c[0] as { expr: string }).expr);
    // svc-a used custom_up, svc-b used global_up
    expect(calls.some((expr) => expr.includes("custom_up") && expr.includes("svc-a"))).toBe(true);
    expect(calls.some((expr) => expr.includes("global_up") && expr.includes("svc-b"))).toBe(true);
    expect(calls.some((expr) => expr.includes("custom_up") && expr.includes("svc-b"))).toBe(false);
    expect(calls.some((expr) => expr.includes("global_up") && expr.includes("svc-a"))).toBe(false);
  });

  it("falls back to globals when override has empty rules array", async () => {
    // An empty override.rules array is effectively "no override" — we use
    // globals rather than "run zero rules", which would defeat the probe.
    // Operators who want zero rules should use {disabled: true}.
    const execute = vi.fn(async () => promResult(1));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    await runProbe({
      services: ["svc-a"],
      probe: buildProbe({
        metrics: [
          { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
        ],
      }),
      providers, datasourceUid: "uid",
      consecutiveState: state,
      getOverride: () => ({ rules: [] }),
      registryStore: fakeRegistryStore(),
    });

    expect(execute).toHaveBeenCalled();
  });

  it("works without a getOverride getter at all (backwards compat)", async () => {
    const execute = vi.fn(async () => promResult(0));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"],
      probe: buildProbe(),
      providers, datasourceUid: "uid",
      consecutiveState: state,
      // no getOverride
      registryStore: fakeRegistryStore(),
    });
    // Availability threshold (<1, consecutiveTicks=1) trips on value=0
    expect(hits.find(h => h.service === "svc-a" && h.ruleName === "availability")).toBeDefined();
  });
});

describe("runProbe — four-track evaluator (Slice C)", () => {
  beforeEach(() => {
    mockTools = {};
    mockLogsTools = {};
  });

  const metricsRule = (over: Partial<ProbeMetricRule> = {}): ProbeMetricRule => ({
    name: "x",
    query: 'up{app="{service}"}',
    threshold: { op: "lt", value: 1 },
    consecutiveTicks: 1,
    source: "metrics",
    ...over,
  });
  const logsRule = (over: Partial<ProbeMetricRule> = {}): ProbeMetricRule => ({
    name: "log_errors",
    query: 'sum(count_over_time({app="svc-a"} |= `error` [15m]))',
    threshold: { op: "gt", value: 75 },
    consecutiveTicks: 1,
    source: "logs",
    ...over,
  });

  it("Track 1: globalProbeRules REPLACE config.yaml defaults when non-empty", async () => {
    // When the registry has any global rules, they replace track 4.
    // Expectation: the probe fires the global rule's query, NOT the
    // config.yaml `up{service="{service}"}` default.
    const execute = vi.fn(async () => promResult(0));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"],
      probe: buildProbe(),
      providers, datasourceUid: "uid",
      consecutiveState: state,
      registryStore: fakeRegistryStore({
        globalProbeRules: [metricsRule({ name: "app_avail", query: 'up{app="{service}"}' })],
      }),
    });

    const calls = execute.mock.calls.map((c) => (c[0] as { expr: string }).expr);
    expect(calls.some((e) => e.includes('up{app="svc-a"}'))).toBe(true);
    // The config.yaml default `up{service=...}` must not have fired.
    expect(calls.some((e) => e.includes('up{service="svc-a"}'))).toBe(false);
    const hit = hits.find((h) => h.ruleName === "app_avail");
    expect(hit).toBeDefined();
    expect(hit!.origin).toBe("global");
  });

  it("Track 4 regression: without any globals, probe still fires config.yaml defaults (byte-identical to pre-Slice-C behavior)", async () => {
    const execute = vi.fn(async () => promResult(0));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"],
      probe: buildProbe(),
      providers, datasourceUid: "uid",
      consecutiveState: state,
      registryStore: fakeRegistryStore({ globalProbeRules: [] }),
    });

    const calls = execute.mock.calls.map((c) => (c[0] as { expr: string }).expr);
    // Config.yaml default `up{service="..."}` fires. This is the PR #115
    // k8s-native fallback path. Regressing this breaks every deployment
    // that hasn't run `npm run discover` yet.
    expect(calls.some((e) => e.includes('up{service="svc-a"}'))).toBe(true);
    const hit = hits.find((h) => h.ruleName === "availability");
    expect(hit).toBeDefined();
    expect(hit!.origin).toBe("default");
  });

  it("Track 2: per-service probeRules ADD to the base track (do not replace)", async () => {
    const execute = vi.fn(async () => promResult(0));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"],
      probe: buildProbe(),
      providers, datasourceUid: "uid",
      consecutiveState: state,
      registryStore: fakeRegistryStore({
        services: [{
          name: "svc-a", metrics: [], logLabels: {},
          // Use a threshold that trips on the mock's promResult(0) so both
          // rules produce visible hits in this additivity assertion.
          probeRules: [metricsRule({ name: "pod_restarts", query: 'rate(restarts{ns="a"}[5m])', threshold: { op: "lt", value: 1 } })],
        } as ServiceConfig],
        globalProbeRules: [metricsRule({ name: "app_avail" })],
      }),
    });

    // Both the global and the per-service rule fire — additive semantics.
    expect(hits.some((h) => h.ruleName === "app_avail" && h.origin === "global")).toBe(true);
    expect(hits.some((h) => h.ruleName === "pod_restarts" && h.origin === "service")).toBe(true);
  });

  it("Track 3: logs-source per-service rule calls the logs tool (not the metrics tool)", async () => {
    const metricsExecute = vi.fn(async () => promResult(0));
    const logsExecute = vi.fn(async () => promResult(120));  // trips > 75
    mockTools = { query_prometheus: { execute: metricsExecute } };
    mockLogsTools = { query_loki_logs: { execute: logsExecute } };

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"],
      probe: buildProbe(),
      providers, datasourceUid: "uid",
      lokiDatasourceUid: "loki-uid",
      consecutiveState: state,
      registryStore: fakeRegistryStore({
        services: [{
          name: "svc-a", metrics: [], logLabels: {},
          probeRules: [logsRule()],
        } as ServiceConfig],
      }),
    });

    // The logs tool was called with queryType:"metric" and the Loki UID.
    expect(logsExecute).toHaveBeenCalled();
    const logsArgs = logsExecute.mock.calls[0]?.[0] as { queryType: string; datasourceUid: string };
    expect(logsArgs.queryType).toBe("metric");
    expect(logsArgs.datasourceUid).toBe("loki-uid");
    // And the log-source rule tripped.
    const hit = hits.find((h) => h.ruleName === "log_errors" && h.origin === "service");
    expect(hit).toBeDefined();
  });

  it("Track 3: log-source rule scores NaN when no logs tool is wired", async () => {
    const metricsExecute = vi.fn(async () => promResult(1));
    mockTools = { query_prometheus: { execute: metricsExecute } };
    mockLogsTools = {};  // no logs tool available

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"],
      probe: buildProbe(),
      providers, datasourceUid: "uid",
      lokiDatasourceUid: "loki-uid",
      consecutiveState: state,
      registryStore: fakeRegistryStore({
        services: [{
          name: "svc-a", metrics: [], logLabels: {},
          probeRules: [logsRule()],
        } as ServiceConfig],
      }),
    });

    // No hit — log-source rule silently scored NaN. Metrics-source rules
    // continue to fire (availability against value=1 doesn't trip).
    expect(hits.find((h) => h.ruleName === "log_errors")).toBeUndefined();
  });

  it("probe.logs fallback fires on service with logLabels + no log-type rule", async () => {
    const metricsExecute = vi.fn(async () => promResult(1));
    const logsExecute = vi.fn(async () => promResult(500));  // high error count
    mockTools = { query_prometheus: { execute: metricsExecute } };
    mockLogsTools = { query_loki_logs: { execute: logsExecute } };

    const state = new Map<string, number>();
    const hits = await runProbe({
      services: ["svc-a"],
      probe: buildProbe({ logs: { enabled: true, window: "15m", errorRateThreshold: 10, consecutiveTicks: 1 } }),
      providers, datasourceUid: "uid",
      lokiDatasourceUid: "loki-uid",
      consecutiveState: state,
      registryStore: fakeRegistryStore({
        services: [{
          name: "svc-a", metrics: [],
          logLabels: { namespace: "checkout", container: "api" },
          probeRules: [],  // NO log-type rule — fallback should generate one
        } as ServiceConfig],
      }),
    });

    // The fallback query was synthesized from logLabels.
    const logsCall = logsExecute.mock.calls[0]?.[0] as { expr: string };
    expect(logsCall.expr).toContain('namespace="checkout"');
    expect(logsCall.expr).toContain('container="api"');
    const hit = hits.find((h) => h.origin === "logs-fallback");
    expect(hit).toBeDefined();
    expect(hit!.ruleName).toBe("log_errors_fallback");
  });

  it("probe.logs fallback does NOT fire when a per-service log-type rule exists", async () => {
    const logsExecute = vi.fn(async () => promResult(0));
    mockTools = { query_prometheus: { execute: vi.fn(async () => promResult(1)) } };
    mockLogsTools = { query_loki_logs: { execute: logsExecute } };

    const state = new Map<string, number>();
    await runProbe({
      services: ["svc-a"],
      probe: buildProbe({ logs: { enabled: true, window: "15m", errorRateThreshold: 10, consecutiveTicks: 1 } }),
      providers, datasourceUid: "uid",
      lokiDatasourceUid: "loki-uid",
      consecutiveState: state,
      registryStore: fakeRegistryStore({
        services: [{
          name: "svc-a", metrics: [],
          logLabels: { namespace: "checkout" },
          probeRules: [logsRule({ name: "my_log_errors" })],
        } as ServiceConfig],
      }),
    });

    // Exactly one logs call — the per-service rule. No synthesized fallback.
    expect(logsExecute).toHaveBeenCalledTimes(1);
  });

  it("Origin-namespaced state keys: same-named rules on different tracks track independently", async () => {
    // A global rule named "availability" and a per-service rule also named
    // "availability" used to share hysteresis state under the pre-Slice-C
    // 2-part key. With origin-namespaced keys, they track independently.
    const execute = vi.fn(async () => promResult(0));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    await runProbe({
      services: ["svc-a"],
      probe: buildProbe(),
      providers, datasourceUid: "uid",
      consecutiveState: state,
      registryStore: fakeRegistryStore({
        services: [{
          name: "svc-a", metrics: [], logLabels: {},
          probeRules: [metricsRule({ name: "availability", query: 'custom{app="{service}"}' })],
        } as ServiceConfig],
        globalProbeRules: [metricsRule({ name: "availability" })],
      }),
    });

    // Both hit → both increment independent counters. Key format:
    // "svc-a:{origin}:availability".
    expect(state.get(stateKey("svc-a", "global", "availability"))).toBe(1);
    expect(state.get(stateKey("svc-a", "service", "availability"))).toBe(1);
  });

  it("Registry snapshot atomicity: loadAll() is called exactly once per tick", async () => {
    const loadAll = vi.fn(() => ({ services: [], globalProbeRules: [] }));
    const execute = vi.fn(async () => promResult(1));
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    await runProbe({
      services: ["svc-a", "svc-b", "svc-c"],
      probe: buildProbe(),
      providers, datasourceUid: "uid",
      consecutiveState: state,
      registryStore: { loadAll } as unknown as ServiceRegistryStore,
    });

    // Even across three services + per-task loop, only one snapshot read.
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it("GCs orphaned consecutiveState entries at tick start (rule rename / removal)", async () => {
    // Simulates what happens when discovery renames a global rule from
    // "availability" to "app_avail" between ticks: old counters under
    // `{svc}:global:availability` must not leak. Pre-load the state Map
    // with an orphan key, run a tick with the new rule name, verify the
    // orphan was cleaned up.
    const execute = vi.fn(async () => promResult(1));  // nothing trips
    mockTools = { query_prometheus: { execute } };

    const state = new Map<string, number>();
    state.set(stateKey("svc-a", "global", "OLD_RENAMED_RULE"), 7);  // orphan from prior tick
    state.set(stateKey("svc-b", "service", "pod_restarts"), 3);     // orphan — svc-b not in this tick

    await runProbe({
      services: ["svc-a"],
      probe: buildProbe(),
      providers, datasourceUid: "uid",
      consecutiveState: state,
      registryStore: fakeRegistryStore({
        globalProbeRules: [metricsRule({ name: "new_rule" })],
      }),
    });

    // Both orphan keys GC'd. No new trips since value=1 doesn't breach.
    expect(state.has(stateKey("svc-a", "global", "OLD_RENAMED_RULE"))).toBe(false);
    expect(state.has(stateKey("svc-b", "service", "pod_restarts"))).toBe(false);
  });
});

describe("prioritizeHits", () => {
  const hitA: ProbeHit = { service: "a", ruleName: "error_rate", origin: "default", value: 0.5, query: "q", threshold: { op: "gt", value: 0.01 }, consecutiveTicks: 2, severity: 49 };
  const hitB: ProbeHit = { service: "b", ruleName: "latency_p99", origin: "default", value: 5, query: "q", threshold: { op: "gt", value: 2 }, consecutiveTicks: 1, severity: 1.5 };
  const hitC: ProbeHit = { service: "c", ruleName: "availability", origin: "default", value: 0, query: "q", threshold: { op: "lt", value: 1 }, consecutiveTicks: 1, severity: 1 };

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
      service: "svc-a", ruleName: "error_rate", origin: "default", value: 0.5, query: "rate(errors)",
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

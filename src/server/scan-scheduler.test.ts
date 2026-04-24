import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScanScheduler, type ScanAnomaliesEvent } from "./scan-scheduler.js";
import type { ScanConfig } from "../config/schema.js";
import type { Database } from "./db.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { ProbeHit } from "./anomaly-probe.js";

// Mock anomaly-probe so the scheduler tests exercise orchestration, not PromQL.
let mockProbeHits: ProbeHit[] = [];
vi.mock("./anomaly-probe.js", async () => {
  const actual = await vi.importActual<typeof import("./anomaly-probe.js")>("./anomaly-probe.js");
  return {
    ...actual,
    runProbe: vi.fn(async () => ({
      hits: mockProbeHits,
      queriesExecuted: mockProbeHits.length,
      probeErrors: 0,
    })),
  };
});

// Mock scan-run-store so scheduler tests don't need real DB writes.
// The mockTracker captures calls so individual tests can assert on them.
const mockTracker = {
  id: "test-run",
  stackId: "s1",
  recordProbeComplete: vi.fn(),
  recordTriageComplete: vi.fn(),
  linkInvestigation: vi.fn(),
  finalize: vi.fn(),
  skip: vi.fn(),
  fail: vi.fn(),
};
const mockBegin = vi.fn((_args: { stackId: string; trigger: "manual" | "cron" }) => mockTracker);

vi.mock("./scan-run-store.js", async () => {
  const actual = await vi.importActual<typeof import("./scan-run-store.js")>("./scan-run-store.js");
  return {
    ...actual,
    createScanRunStore: vi.fn(() => ({ begin: mockBegin })),
  };
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeScanConfig(overrides: Partial<ScanConfig> = {}): ScanConfig {
  return {
    enabled: true,
    cron: "0 */4 * * *",
    timezone: "UTC",
    maxInvestigationsPerTick: 5,
    investigationTemplate: "standard",
    runOnEnable: false,
    dedupWindowMinutes: 30,
    probe: {
      concurrency: 4,
      queryTimeoutMs: 1000,
      metrics: [
        { name: "availability", query: "up", threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
      ],
      logs: { enabled: false, window: "15m", errorRateThreshold: 10, consecutiveTicks: 2 },
    },
    ...overrides,
  };
}

function makeHit(service: string, severity = 1, ruleName = "availability"): ProbeHit {
  return {
    service, ruleName,
    value: 0, query: "up", threshold: { op: "lt", value: 1 },
    consecutiveTicks: 1, severity,
  };
}

function makeDb(options: {
  hasRecent?: (stackId: string, service: string) => boolean;
  lastAt?: (stackId: string, service: string) => number | null;
  overrides?: Record<string, string>;
} = {}): Database {
  return {
    hasRecentInvestigation: vi.fn((stackId: string, service: string, _win: number) =>
      options.hasRecent ? options.hasRecent(stackId, service) : false
    ),
    getLastInvestigationAt: vi.fn((stackId: string, service: string) =>
      options.lastAt ? options.lastAt(stackId, service) : null
    ),
    // Lane B Step 4: scheduler reads overrides once per tick. Default to empty —
    // individual tests override when they want per-service behaviors.
    getAllScanOverrides: vi.fn((_stackId: string) => options.overrides ?? {}),
  } as unknown as Database;
}

function makeRegistry(services: string[]): ServiceRegistryStore {
  return {
    load: vi.fn(() => services.map((name) => ({ name, metrics: [], logLabels: {} }))),
  } as unknown as ServiceRegistryStore;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ScanScheduler.start", () => {
  beforeEach(() => { mockProbeHits = []; });
  afterEach(() => { vi.useRealTimers(); });

  it("is a no-op when scan.enabled=false", () => {
    const onAnomaliesDetected = vi.fn();
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig({ enabled: false }),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected,
    });
    scheduler.start();
    expect(scheduler.getStatus().enabled).toBe(false);
    expect(scheduler.getStatus().nextRun).toBeNull();
    scheduler.stop();
  });

  it("schedules cron when enabled and sets nextRun", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    expect(scheduler.getStatus().nextRun).not.toBeNull();
    scheduler.stop();
  });

  it("captures lastError when cron expression is invalid", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig({ cron: "not-a-cron" }),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    expect(scheduler.getStatus().lastError).toContain("Invalid cron");
    expect(scheduler.getStatus().nextRun).toBeNull();
  });

  it("is idempotent (calling start twice does not double-schedule)", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    const firstNextRun = scheduler.getStatus().nextRun;
    scheduler.start(); // re-entry
    expect(scheduler.getStatus().nextRun).toBe(firstNextRun);
    scheduler.stop();
  });
});

describe("ScanScheduler.triggerNow", () => {
  beforeEach(() => { mockProbeHits = []; });

  it("skips when no datasource UID is available", async () => {
    const onAnomaliesDetected = vi.fn();
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry(["svc-a"]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => undefined, onAnomaliesDetected,
    });
    scheduler.start();
    await scheduler.triggerNow();
    expect(onAnomaliesDetected).not.toHaveBeenCalled();
    expect(scheduler.getStatus().lastError).toContain("no Prometheus datasource");
    scheduler.stop();
  });

  it("skips when registry is empty", async () => {
    const onAnomaliesDetected = vi.fn();
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected,
    });
    scheduler.start();
    await scheduler.triggerNow();
    expect(onAnomaliesDetected).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("fires onAnomaliesDetected when probe returns hits", async () => {
    mockProbeHits = [makeHit("svc-a", 5), makeHit("svc-b", 2)];
    const onAnomaliesDetected = vi.fn();
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry(["svc-a", "svc-b"]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected,
    });
    scheduler.start();
    await scheduler.triggerNow();
    expect(onAnomaliesDetected).toHaveBeenCalledTimes(1);
    const evt = onAnomaliesDetected.mock.calls[0]![0] as ScanAnomaliesEvent;
    expect(evt.hits).toHaveLength(2);
    expect(evt.hits[0]!.service).toBe("svc-a"); // sorted by severity desc
    scheduler.stop();
  });

  it("drops hits for recently-investigated services (scan dedup)", async () => {
    mockProbeHits = [makeHit("svc-a"), makeHit("svc-b")];
    const onAnomaliesDetected = vi.fn();
    const db = makeDb({ hasRecent: (_s, svc) => svc === "svc-a" });
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry(["svc-a", "svc-b"]), db,
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected,
    });
    scheduler.start();
    await scheduler.triggerNow();
    expect(onAnomaliesDetected).toHaveBeenCalledTimes(1);
    const evt = onAnomaliesDetected.mock.calls[0]![0] as ScanAnomaliesEvent;
    expect(evt.hits.map(h => h.service)).toEqual(["svc-b"]);
    scheduler.stop();
  });

  it("caps at maxInvestigationsPerTick and increments dropsByConcurrency for overflow", async () => {
    mockProbeHits = [
      makeHit("s1", 10), makeHit("s2", 9), makeHit("s3", 8),
      makeHit("s4", 7), makeHit("s5", 6), makeHit("s6", 5),
      makeHit("s7", 4),
    ];
    const onAnomaliesDetected = vi.fn();
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry(["s1","s2","s3","s4","s5","s6","s7"]),
      db: makeDb(),
      stackId: "s1", scan: makeScanConfig({ maxInvestigationsPerTick: 3 }),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected,
    });
    scheduler.start();
    await scheduler.triggerNow();
    const evt = onAnomaliesDetected.mock.calls[0]![0] as ScanAnomaliesEvent;
    expect(evt.hits).toHaveLength(3);
    expect(evt.hits.map(h => h.service)).toEqual(["s1", "s2", "s3"]);
    expect(scheduler.getStatus().dropsByConcurrency).toBe(4);
    scheduler.stop();
  });

  it("does not fire onAnomaliesDetected when all hits are deduped", async () => {
    mockProbeHits = [makeHit("svc-a"), makeHit("svc-b")];
    const onAnomaliesDetected = vi.fn();
    const db = makeDb({ hasRecent: () => true });
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry(["svc-a", "svc-b"]), db,
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected,
    });
    scheduler.start();
    await scheduler.triggerNow();
    expect(onAnomaliesDetected).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("sets lastRun on completion", async () => {
    const onAnomaliesDetected = vi.fn();
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry(["svc-a"]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected,
    });
    scheduler.start();
    expect(scheduler.getStatus().lastRun).toBeNull();
    await scheduler.triggerNow();
    expect(scheduler.getStatus().lastRun).not.toBeNull();
    scheduler.stop();
  });

  it("uses tiebreak (oldest last-investigated) at equal severity", async () => {
    mockProbeHits = [
      makeHit("recent", 5), makeHit("old", 5),
    ];
    const onAnomaliesDetected = vi.fn();
    const now = Date.now();
    const db = makeDb({
      lastAt: (_s, svc) => svc === "recent" ? now : (now - 3_600_000),
    });
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry(["recent", "old"]), db,
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected,
    });
    scheduler.start();
    await scheduler.triggerNow();
    const evt = onAnomaliesDetected.mock.calls[0]![0] as ScanAnomaliesEvent;
    expect(evt.hits[0]!.service).toBe("old");
    scheduler.stop();
  });
});

describe("ScanScheduler.stop", () => {
  beforeEach(() => { mockProbeHits = []; });

  it("is idempotent", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
  });

  it("clears nextRun after stop", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    expect(scheduler.getStatus().nextRun).not.toBeNull();
    scheduler.stop();
    expect(scheduler.getStatus().nextRun).toBeNull();
  });
});

describe("ScanScheduler.getStatus", () => {
  it("returns snapshot with expected shape", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    const status = scheduler.getStatus();
    expect(status).toHaveProperty("enabled");
    expect(status).toHaveProperty("cron");
    expect(status).toHaveProperty("timezone");
    expect(status).toHaveProperty("nextRun");
    expect(status).toHaveProperty("lastRun");
    expect(status).toHaveProperty("lastError");
    expect(status).toHaveProperty("dropsByConcurrency");
    expect(status).toHaveProperty("ticking");
    expect(status.dropsByConcurrency).toBe(0);
  });
});

describe("ScanScheduler.reload", () => {
  it("starts the scheduler when enabled flips false → true", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig({ enabled: false }),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    expect(scheduler.getStatus().nextRun).toBeNull();

    scheduler.reload(makeScanConfig({ enabled: true }));
    expect(scheduler.getStatus().enabled).toBe(true);
    expect(scheduler.getStatus().nextRun).not.toBeNull();
    scheduler.stop();
  });

  it("stops the scheduler when enabled flips true → false", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig({ enabled: true }),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    expect(scheduler.getStatus().nextRun).not.toBeNull();

    scheduler.reload(makeScanConfig({ enabled: false }));
    expect(scheduler.getStatus().enabled).toBe(false);
    expect(scheduler.getStatus().nextRun).toBeNull();
  });

  it("can re-enable after a disable reload", () => {
    // Regression for the `stopped` flag — previously, a disable via reload
    // could leave the scheduler in a state where re-enabling did nothing.
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig({ enabled: true }),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    scheduler.reload(makeScanConfig({ enabled: false }));
    scheduler.reload(makeScanConfig({ enabled: true }));
    expect(scheduler.getStatus().enabled).toBe(true);
    expect(scheduler.getStatus().nextRun).not.toBeNull();
    scheduler.stop();
  });

  it("reschedules the cron when the expression changes while enabled", () => {
    // Use two crons that cannot coincidentally fire at the same moment:
    // daily at 01:00 UTC vs daily at 23:00 UTC always differ by >= 2h.
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig({ enabled: true, cron: "0 1 * * *" }),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    const before = scheduler.getStatus().nextRun;

    scheduler.reload(makeScanConfig({ enabled: true, cron: "0 23 * * *" }));
    const after = scheduler.getStatus().nextRun;

    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    scheduler.stop();
  });

  it("reschedules the cron when only the timezone changes", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig({ enabled: true, cron: "0 12 * * *", timezone: "UTC" }),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    const before = scheduler.getStatus().nextRun;

    scheduler.reload(makeScanConfig({ enabled: true, cron: "0 12 * * *", timezone: "America/New_York" }));
    const after = scheduler.getStatus().nextRun;

    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    scheduler.stop();
  });

  it("is a no-op when the new config equals the current config", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig({ enabled: true }),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    const before = scheduler.getStatus().nextRun;

    scheduler.reload(makeScanConfig({ enabled: true }));
    expect(scheduler.getStatus().nextRun).toBe(before);
    scheduler.stop();
  });

  it("applies non-schedule config changes without restarting the cron", () => {
    // maxInvestigationsPerTick change should NOT reset nextRun — the next
    // tick just picks up the new value.
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig({ enabled: true, maxInvestigationsPerTick: 5 }),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    scheduler.start();
    const before = scheduler.getStatus().nextRun;

    scheduler.reload(makeScanConfig({ enabled: true, maxInvestigationsPerTick: 10 }));
    expect(scheduler.getStatus().nextRun).toBe(before);
    scheduler.stop();
  });
});

describe("ScanScheduler.reload — probe rule diff hysteresis reset", () => {
  /**
   * Access the scheduler's private `consecutiveState` Map for verification.
   * We pre-seed it to simulate in-flight hysteresis, then verify reload
   * clears the right entries and keeps the rest.
   */
  function peekState(scheduler: ScanScheduler): Map<string, number> {
    return (scheduler as unknown as { consecutiveState: Map<string, number> }).consecutiveState;
  }

  function configWithRules(rules: { name: string; query: string; threshold: { op: "gt" | "lt" | "gte" | "lte"; value: number }; consecutiveTicks: number }[]) {
    return makeScanConfig({
      enabled: true,
      probe: {
        concurrency: 4,
        queryTimeoutMs: 1000,
        metrics: rules,
        logs: { enabled: false, window: "15m", errorRateThreshold: 10, consecutiveTicks: 2 },
      },
    });
  }

  it("clears state for removed rules", () => {
    const before = configWithRules([
      { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
      { name: "error_rate", query: 'rate{service="{service}"}', threshold: { op: "gt", value: 0.01 }, consecutiveTicks: 2 },
    ]);
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: before,
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    const state = peekState(scheduler);
    state.set("svc-a:availability", 1);
    state.set("svc-a:error_rate", 1);
    state.set("svc-b:error_rate", 1);

    scheduler.reload(configWithRules([
      { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
      // error_rate removed
    ]));

    expect(state.has("svc-a:availability")).toBe(true);
    expect(state.has("svc-a:error_rate")).toBe(false);
    expect(state.has("svc-b:error_rate")).toBe(false);
    scheduler.stop();
  });

  it("clears state when a rule's query changes (material change)", () => {
    const before = configWithRules([
      { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
    ]);
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: before,
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    const state = peekState(scheduler);
    state.set("svc-a:availability", 2);

    scheduler.reload(configWithRules([
      // Same name, different query
      { name: "availability", query: 'up{app="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
    ]));

    expect(state.has("svc-a:availability")).toBe(false);
    scheduler.stop();
  });

  it("clears state when a rule's threshold changes", () => {
    const before = configWithRules([
      { name: "err", query: 'r{service="{service}"}', threshold: { op: "gt", value: 0.01 }, consecutiveTicks: 2 },
    ]);
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: before,
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    const state = peekState(scheduler);
    state.set("svc-a:err", 1);

    scheduler.reload(configWithRules([
      { name: "err", query: 'r{service="{service}"}', threshold: { op: "gt", value: 0.05 }, consecutiveTicks: 2 },
    ]));

    expect(state.has("svc-a:err")).toBe(false);
    scheduler.stop();
  });

  it("keeps state when ONLY consecutiveTicks changes", () => {
    // consecutiveTicks moves the firing bar but doesn't invalidate the
    // current breach counter — reset would be overly aggressive.
    const before = configWithRules([
      { name: "err", query: 'r{service="{service}"}', threshold: { op: "gt", value: 0.01 }, consecutiveTicks: 2 },
    ]);
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: before,
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    const state = peekState(scheduler);
    state.set("svc-a:err", 1);

    scheduler.reload(configWithRules([
      { name: "err", query: 'r{service="{service}"}', threshold: { op: "gt", value: 0.01 }, consecutiveTicks: 5 },
    ]));

    expect(state.get("svc-a:err")).toBe(1);
    scheduler.stop();
  });

  it("keeps state for entirely unchanged rules across a reload", () => {
    const rules = [
      { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt" as const, value: 1 }, consecutiveTicks: 1 },
    ];
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: configWithRules(rules),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    const state = peekState(scheduler);
    state.set("svc-a:availability", 3);

    scheduler.reload(configWithRules(rules));

    expect(state.get("svc-a:availability")).toBe(3);
    scheduler.stop();
  });

  it("does NOT clear state for newly-added rules (they start fresh anyway)", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: configWithRules([
        { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
      ]),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    const state = peekState(scheduler);
    state.set("svc-a:availability", 2);

    scheduler.reload(configWithRules([
      { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1 },
      { name: "new_rule", query: 'x{service="{service}"}', threshold: { op: "gt", value: 0 }, consecutiveTicks: 1 },
    ]));

    // Old rule's state preserved; nothing there for new_rule yet
    expect(state.get("svc-a:availability")).toBe(2);
    expect(state.has("svc-a:new_rule")).toBe(false);
    scheduler.stop();
  });
});

describe("ScanScheduler.resetHysteresisForService", () => {
  function peekState(scheduler: ScanScheduler): Map<string, number> {
    return (scheduler as unknown as { consecutiveState: Map<string, number> }).consecutiveState;
  }

  it("clears only the target service's entries, keeps other services'", () => {
    // Routes call this when a per-service override is set or cleared. The
    // rule set for that one service may have changed, so its tick counters
    // are stale. Other services are untouched.
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    const state = peekState(scheduler);
    state.set("svc-a:availability", 2);
    state.set("svc-a:error_rate", 1);
    state.set("svc-b:availability", 3);

    scheduler.resetHysteresisForService("svc-a");

    expect(state.has("svc-a:availability")).toBe(false);
    expect(state.has("svc-a:error_rate")).toBe(false);
    expect(state.get("svc-b:availability")).toBe(3);
    scheduler.stop();
  });

  it("is a no-op when no entries exist for the service", () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    const state = peekState(scheduler);
    state.set("svc-b:availability", 1);

    scheduler.resetHysteresisForService("svc-a");

    expect(state.get("svc-b:availability")).toBe(1);
    scheduler.stop();
  });

  it("does not match services whose names are prefixes of another (':' boundary honored)", () => {
    // "svc" is a prefix of "svc-a" but the key boundary is ':' after the
    // full service name. Without ':'-boundary matching, "svc" reset could
    // wrongly nuke "svc-a"'s entries.
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid", onAnomaliesDetected: vi.fn(),
    });
    const state = peekState(scheduler);
    state.set("svc:availability", 2);
    state.set("svc-a:availability", 3);

    scheduler.resetHysteresisForService("svc");

    expect(state.has("svc:availability")).toBe(false);
    expect(state.get("svc-a:availability")).toBe(3);
    scheduler.stop();
  });
});

describe("ScanScheduler — ScanRunTracker integration", () => {
  beforeEach(() => {
    mockBegin.mockClear();
    mockTracker.recordProbeComplete.mockClear();
    mockTracker.recordTriageComplete.mockClear();
    mockTracker.finalize.mockClear();
    mockTracker.skip.mockClear();
    mockTracker.fail.mockClear();
    mockTracker.linkInvestigation.mockClear();
    mockProbeHits = [];
  });

  it("tick() creates run + finalizes complete", async () => {
    mockProbeHits = [];
    const db = makeDb();
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry(["svc-a"]), db,
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid",
      onAnomaliesDetected: vi.fn(),
    });
    await scheduler.triggerNow("manual");
    expect(mockBegin).toHaveBeenCalledWith({ stackId: "s1", trigger: "manual" });
    expect(mockTracker.recordProbeComplete).toHaveBeenCalled();
    expect(mockTracker.recordTriageComplete).toHaveBeenCalled();
    expect(mockTracker.finalize).toHaveBeenCalledWith("complete");
  });

  it("skips with 'no_provider' when datasource unavailable", async () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry(["svc-a"]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => undefined,
      onAnomaliesDetected: vi.fn(),
    });
    await scheduler.triggerNow("manual");
    expect(mockTracker.skip).toHaveBeenCalledWith("no_provider");
  });

  it("skips with 'empty_registry' on no services", async () => {
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry([]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid",
      onAnomaliesDetected: vi.fn(),
    });
    await scheduler.triggerNow("manual");
    expect(mockTracker.skip).toHaveBeenCalledWith("empty_registry");
  });

  it("passes runId in onAnomaliesDetected payload when hits dispatched", async () => {
    mockProbeHits = [makeHit("svc-a", 1)];
    const onAnomaliesDetected = vi.fn();
    const scheduler = new ScanScheduler({
      providers: () => [], registryStore: makeRegistry(["svc-a"]), db: makeDb(),
      stackId: "s1", scan: makeScanConfig(),
      getPrometheusDatasourceUid: () => "uid",
      onAnomaliesDetected,
    });
    await scheduler.triggerNow("manual");
    expect(onAnomaliesDetected).toHaveBeenCalledWith(expect.objectContaining({
      stackId: "s1", runId: "test-run", hits: expect.any(Array),
    }));
  });
});

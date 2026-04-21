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
    runProbe: vi.fn(async () => mockProbeHits),
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
} = {}): Database {
  return {
    hasRecentInvestigation: vi.fn((stackId: string, service: string, _win: number) =>
      options.hasRecent ? options.hasRecent(stackId, service) : false
    ),
    getLastInvestigationAt: vi.fn((stackId: string, service: string) =>
      options.lastAt ? options.lastAt(stackId, service) : null
    ),
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

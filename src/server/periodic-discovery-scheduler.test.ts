import { describe, it, expect, beforeEach, vi } from "vitest";
import { Database } from "./db.js";
import { PendingDiscoveryStore } from "./pending-discovery-store.js";
import { PeriodicDiscoveryScheduler } from "./periodic-discovery-scheduler.js";

let db: Database;
let store: PendingDiscoveryStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new PendingDiscoveryStore(db.raw());
});

const baseDeps = () => ({
  store,
  stackId: "s",
  providers: () => [],
  getPrometheusDatasourceUid: () => "ds-1" as string | undefined,
  registryStore: {
    loadAll: () => ({ services: [], globalProbeRules: [] }),
    listVersions: () => [],
    load: () => [],
    save: () => "",
  } as any,
  runDiscovery: vi.fn().mockResolvedValue({ services: [], globalProbeRules: [] }),
  notifySlack: vi.fn().mockResolvedValue({ ok: true }),
  notifyEmail: vi.fn().mockResolvedValue({ ok: true }),
  llmRetry: undefined,
});

describe("PeriodicDiscoveryScheduler — skip predicates", () => {
  it("skips and records 'skipped' run when no providers", async () => {
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [],
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    const runs = store.listRuns("s");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("skipped");
    expect(runs[0]!.error).toMatch(/provider|datasource/i);
  });

  it("skips when Prometheus datasource UID missing", async () => {
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      getPrometheusDatasourceUid: () => undefined,
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    const runs = store.listRuns("s");
    expect(runs[0]!.status).toBe("skipped");
  });

  it("overlap protection: a second tickOnce while the first is in flight returns skipped", async () => {
    let resolveDiscovery: (v: any) => void = () => {};
    const slowDiscovery = vi.fn().mockReturnValue(new Promise((r) => { resolveDiscovery = r; }));
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      runDiscovery: slowDiscovery,
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    const p1 = sched.tickOnce();
    const overlap = await sched.tickOnce();
    expect(overlap.skipped).toBe(true);
    expect(overlap.reason).toMatch(/already running|in progress/i);
    resolveDiscovery({ services: [], globalProbeRules: [] });
    await p1;
  });

  it("startup: orphaned 'running' rows from previous process flip to 'failed: interrupted'", () => {
    const orphan = store.startRun("s");
    expect(store.getRun(orphan)!.status).toBe("running");
    new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      settings: { enabled: false, cron: "", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    expect(store.getRun(orphan)!.status).toBe("failed");
    expect(store.getRun(orphan)!.error).toBe("interrupted");
  });
});

describe("PeriodicDiscoveryScheduler — runDiscovery error handling", () => {
  it("records 'failed' when runDiscovery throws", async () => {
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      runDiscovery: vi.fn().mockRejectedValue(new Error("LLM timeout")),
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    const runs = store.listRuns("s");
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error).toContain("LLM timeout");
  });
});

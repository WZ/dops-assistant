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

const verifiedSvc = (name: string) => ({
  name,
  metrics: [{ query: `up{service="${name}"}`, description: "up" }],
  logLabels: { container: name },
  probeRules: [],
  confidence: "verified",
});

describe("PeriodicDiscoveryScheduler — addition consensus", () => {
  it("first run with one verified candidate: row created, not qualified", async () => {
    const probe = vi.fn().mockResolvedValue({ kind: "ok", value: 1 });
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      runDiscovery: vi.fn().mockResolvedValue({ services: [verifiedSvc("svc-a")], globalProbeRules: [] }),
      sanityProbe: probe,
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    const row = store.findByStackKindName("s", "addition", "svc-a");
    expect(row).not.toBeNull();
    expect(row!.seenCount).toBe(1);
    expect(row!.qualifiedAt).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("second consecutive run qualifies the candidate", async () => {
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      runDiscovery: vi.fn().mockResolvedValue({ services: [verifiedSvc("svc-a")], globalProbeRules: [] }),
      sanityProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    await sched.tickOnce();
    const row = store.findByStackKindName("s", "addition", "svc-a")!;
    expect(row.seenCount).toBe(2);
    expect(row.qualifiedAt).not.toBeNull();
  });

  it("drops non-verified candidates", async () => {
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      runDiscovery: vi.fn().mockResolvedValue({
        services: [{ ...verifiedSvc("svc-a"), confidence: "partial" }],
        globalProbeRules: [],
      }),
      sanityProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    expect(store.findByStackKindName("s", "addition", "svc-a")).toBeNull();
  });

  it("drops candidates whose sanity probe returns empty", async () => {
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      runDiscovery: vi.fn().mockResolvedValue({ services: [verifiedSvc("svc-a")], globalProbeRules: [] }),
      sanityProbe: vi.fn().mockResolvedValue({ kind: "empty", value: NaN }),
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    expect(store.findByStackKindName("s", "addition", "svc-a")).toBeNull();
  });

  it("services with empty metrics array skip the sanity probe and proceed to consensus", async () => {
    const probe = vi.fn();
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      runDiscovery: vi.fn().mockResolvedValue({
        services: [{ ...verifiedSvc("svc-a"), metrics: [] }],
        globalProbeRules: [],
      }),
      sanityProbe: probe,
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(store.findByStackKindName("s", "addition", "svc-a")).not.toBeNull();
  });
});

describe("PeriodicDiscoveryScheduler — removal consensus", () => {
  const registryWithSvcX = () => ({
    loadAll: () => ({
      services: [{ name: "svc-x", metrics: [{ query: "up{service=\"svc-x\"}", description: "" }], logLabels: {}, probeRules: [] }],
      globalProbeRules: [],
    }),
    listVersions: () => [{ id: "vReg-1" }],
    load: () => [{ name: "svc-x", metrics: [{ query: "up{service=\"svc-x\"}", description: "" }], logLabels: {}, probeRules: [] }],
    save: () => "",
  } as any);

  it("removal candidate without Prom corroboration does not advance consensus", async () => {
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      registryStore: registryWithSvcX(),
      runDiscovery: vi.fn().mockResolvedValue({ services: [], globalProbeRules: [] }),
      sanityProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      removalCorroborationProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    expect(store.findByStackKindName("s", "removal", "svc-x")).toBeNull();
  });

  it("corroborated removal qualifies after consensusRunsForRemovals consecutive runs", async () => {
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      registryStore: registryWithSvcX(),
      runDiscovery: vi.fn().mockResolvedValue({ services: [], globalProbeRules: [] }),
      sanityProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      removalCorroborationProbe: vi.fn().mockResolvedValue({ kind: "empty", value: NaN }),
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce(); await sched.tickOnce(); await sched.tickOnce();
    const row = store.findByStackKindName("s", "removal", "svc-x")!;
    expect(row.seenCount).toBe(3);
    expect(row.qualifiedAt).not.toBeNull();
  });

  it("recovery: when svc-x reappears in discovery, its removal row is deleted", async () => {
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      registryStore: registryWithSvcX(),
      runDiscovery: vi.fn()
        .mockResolvedValueOnce({ services: [], globalProbeRules: [] })
        .mockResolvedValueOnce({ services: [verifiedSvc("svc-x")], globalProbeRules: [] }),
      sanityProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      removalCorroborationProbe: vi.fn().mockResolvedValue({ kind: "empty", value: NaN }),
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    expect(store.findByStackKindName("s", "removal", "svc-x")).not.toBeNull();
    await sched.tickOnce();
    expect(store.findByStackKindName("s", "removal", "svc-x")).toBeNull();
  });
});

describe("PeriodicDiscoveryScheduler — notifications", () => {
  it("fires Slack and Email exactly once across two ticks when both succeed", async () => {
    const slack = vi.fn().mockResolvedValue({ ok: true });
    const email = vi.fn().mockResolvedValue({ ok: true });
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      runDiscovery: vi.fn().mockResolvedValue({ services: [verifiedSvc("svc-a")], globalProbeRules: [] }),
      sanityProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      notifySlack: slack,
      notifyEmail: email,
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce();
    await sched.tickOnce();
    await sched.tickOnce();
    expect(slack).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
  });

  it("retries only the failed channel on next tick", async () => {
    const slack = vi.fn().mockResolvedValueOnce({ ok: false, error: "5xx" }).mockResolvedValueOnce({ ok: true });
    const email = vi.fn().mockResolvedValue({ ok: true });
    const sched = new PeriodicDiscoveryScheduler({
      ...baseDeps(),
      providers: () => [{} as any],
      runDiscovery: vi.fn().mockResolvedValue({ services: [verifiedSvc("svc-a")], globalProbeRules: [] }),
      sanityProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      notifySlack: slack,
      notifyEmail: email,
      settings: { enabled: true, cron: "0 0 * * *", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3 },
    });
    await sched.tickOnce(); await sched.tickOnce();
    expect(slack).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
    await sched.tickOnce();
    expect(slack).toHaveBeenCalledTimes(2);
    expect(email).toHaveBeenCalledTimes(1);
  });
});

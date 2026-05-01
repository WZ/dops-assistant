// Integration smoke test for the periodic discovery loop. Exercises the full
// path: scheduler tick → runDiscovery → verified filter → sanity probe →
// consensus update → notifications. Does NOT cover routes (those have their
// own tests in routes.test.ts) or the UI.

import { describe, it, expect, vi } from "vitest";
import { Database } from "./db.js";
import { PendingDiscoveryStore } from "./pending-discovery-store.js";
import { PeriodicDiscoveryScheduler } from "./periodic-discovery-scheduler.js";

describe("periodic discovery — integration smoke", () => {
  it("addition qualifies after 2 successful ticks; Slack notification fires once", async () => {
    const db = new Database(":memory:");
    const store = new PendingDiscoveryStore(db.raw());
    const slack = vi.fn().mockResolvedValue({ ok: true });

    const sched = new PeriodicDiscoveryScheduler({
      store, stackId: "s",
      providers: () => [{}] as any,
      getPrometheusDatasourceUid: () => "ds-1",
      registryStore: {
        loadAll: () => ({ services: [], globalProbeRules: [] }),
        listVersions: () => [],
        load: () => [],
        save: () => "",
      } as any,
      runDiscovery: vi.fn().mockResolvedValue({
        services: [{
          name: "svc-a",
          metrics: [{ query: "up{}", description: "" }],
          logLabels: {},
          probeRules: [],
          confidence: "verified",
        }],
        globalProbeRules: [],
      }),
      sanityProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      removalCorroborationProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      notifySlack: slack,
      notifyEmail: vi.fn().mockResolvedValue({ ok: true }),
      settings: {
        enabled: true, cron: "0 0 * * *", timezone: "UTC",
        consensusRuns: 2, consensusRunsForRemovals: 3,
      },
    });

    await sched.tickOnce();
    await sched.tickOnce();

    const row = store.findByStackKindName("s", "addition", "svc-a")!;
    expect(row.qualifiedAt).not.toBeNull();
    expect(slack).toHaveBeenCalledTimes(1);
  });

  it("removal qualifies after 3 corroborated ticks (default consensusRunsForRemovals=3)", async () => {
    const db = new Database(":memory:");
    const store = new PendingDiscoveryStore(db.raw());

    const sched = new PeriodicDiscoveryScheduler({
      store, stackId: "s",
      providers: () => [{}] as any,
      getPrometheusDatasourceUid: () => "ds-1",
      registryStore: {
        loadAll: () => ({
          services: [{
            name: "svc-x",
            metrics: [{ query: 'up{service="svc-x"}', description: "" }],
            logLabels: {}, probeRules: [],
          }],
          globalProbeRules: [],
        }),
        listVersions: () => [{ id: "v1" }],
        load: () => [{
          name: "svc-x",
          metrics: [{ query: 'up{service="svc-x"}', description: "" }],
          logLabels: {}, probeRules: [],
        } as any],
        save: () => "",
      } as any,
      runDiscovery: vi.fn().mockResolvedValue({ services: [], globalProbeRules: [] }),
      sanityProbe: vi.fn().mockResolvedValue({ kind: "ok", value: 1 }),
      removalCorroborationProbe: vi.fn().mockResolvedValue({ kind: "empty", value: NaN }),
      notifySlack: vi.fn().mockResolvedValue({ ok: true }),
      notifyEmail: vi.fn().mockResolvedValue({ ok: true }),
      settings: {
        enabled: true, cron: "0 0 * * *", timezone: "UTC",
        consensusRuns: 2, consensusRunsForRemovals: 3,
      },
    });

    await sched.tickOnce();
    await sched.tickOnce();
    await sched.tickOnce();

    const row = store.findByStackKindName("s", "removal", "svc-x")!;
    expect(row.seenCount).toBe(3);
    expect(row.qualifiedAt).not.toBeNull();
  });
});

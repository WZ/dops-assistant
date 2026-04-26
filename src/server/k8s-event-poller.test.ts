import { describe, it, expect, vi } from "vitest";
import {
  K8sEventPoller,
  matchEventsToServices,
  type K8sEventPollerDeps,
  type K8sEventHit,
  type DegradedReason,
} from "./k8s-event-poller.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { Database } from "./db.js";

function makeRegistryStore(services: Array<{ name: string; logLabels?: Record<string, string> }> = []): ServiceRegistryStore {
  return {
    load: vi.fn().mockReturnValue(
      services.map((s) => ({ name: s.name, metrics: [], logLabels: s.logLabels ?? {}, probeRules: [] })),
    ),
    loadAll: vi.fn().mockReturnValue({
      services: services.map((s) => ({ name: s.name, metrics: [], logLabels: s.logLabels ?? {}, probeRules: [] })),
      globalProbeRules: [],
    }),
  } as unknown as ServiceRegistryStore;
}

function makeDb(): Database {
  return {} as unknown as Database;
}

function makeDeps(opts: Partial<K8sEventPollerDeps> = {}): K8sEventPollerDeps {
  return {
    providers: opts.providers ?? [],
    registryStore: opts.registryStore ?? makeRegistryStore(),
    db: opts.db ?? makeDb(),
    stackId: opts.stackId ?? "test-stack",
    config: opts.config ?? {
      enabled: true,
      intervalSeconds: 300,
      badReasons: ["OOMKilled"],
      ignoreReasons: ["Completed"],
      maxEventsPerTick: 50,
      queryTimeoutMs: 15_000,
    },
    onK8sEvent: opts.onK8sEvent,
    getHiddenServices: opts.getHiddenServices,
  };
}

describe("K8sEventPoller skeleton", () => {
  it("constructs with default state — no degraded reason, no last tick, no hits", () => {
    const poller = new K8sEventPoller(makeDeps());
    expect(poller.getDegradedReason()).toBeNull();
    expect(poller.getLastTickAt()).toBeNull();
    expect(poller.getRecentHits(10)).toEqual([]);
  });

  it("start/stop is idempotent", () => {
    const poller = new K8sEventPoller(makeDeps());
    poller.start();
    poller.start();   // second call is a no-op
    poller.stop();
    poller.stop();    // second call is a no-op
    // No assertion needed — just verify nothing throws.
  });
});

function makeProvider(toolMap: Record<string, { execute: (args: unknown) => Promise<unknown> }>): MastraProvider {
  return {
    name: "infra",
    roles: ["infrastructure"],
    client: {
      listTools: vi.fn().mockResolvedValue(toolMap),
    },
  } as unknown as MastraProvider;
}

describe("K8sEventPoller.resolveInfraTools", () => {
  it("sets infrastructure-role-not-resolved when no infra provider exists", async () => {
    const poller = new K8sEventPoller(makeDeps({ providers: [] }));
    await poller.poll();
    expect(poller.getDegradedReason()).toBe("infrastructure-role-not-resolved");
  });

  it("sets infrastructure-not-kubernetes when infra provider exists but lacks k8s tools", async () => {
    const provider = makeProvider({
      list_clusters: { execute: vi.fn().mockResolvedValue({}) },
    });
    const poller = new K8sEventPoller(makeDeps({ providers: [provider] }));
    await poller.poll();
    expect(poller.getDegradedReason()).toBe("infrastructure-not-kubernetes");
  });

  it("clears degraded state once both list_pods and list_events are present", async () => {
    const provider = makeProvider({
      list_pods: { execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: '{"items":[]}' }] }) },
      list_events: { execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: '{"items":[]}' }] }) },
    });
    const poller = new K8sEventPoller(makeDeps({
      providers: [provider],
      registryStore: makeRegistryStore([{ name: "svcA", logLabels: { namespace: "ns1" } }]),
    }));
    await poller.poll();
    expect(poller.getDegradedReason()).toBeNull();
  });
});

describe("matchEventsToServices", () => {
  const services = new Set(["serviceA", "serviceB"]);
  const badReasons = new Set(["OOMKilled", "CrashLoopBackOff"]);
  const ignoreReasons = new Set(["Completed"]);

  it("matches event for registered service via deployment owner ref", () => {
    const events = [
      {
        reason: "OOMKilled",
        message: "Container killed",
        lastTimestamp: "2026-04-26T12:00:00Z",
        involvedObject: { kind: "Pod", name: "serviceA-7f8c-xyz", uid: "uid-1" },
        type: "Warning",
      },
    ];
    const hits = matchEventsToServices(events, services, badReasons, ignoreReasons);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      service: "serviceA",
      reason: "OOMKilled",
      podUid: "uid-1",
      source: "event",
    });
  });

  it("skips events with reasons not on the bad list", () => {
    const events = [
      { reason: "Pulling", message: "x", lastTimestamp: "2026-04-26T12:00:00Z",
        involvedObject: { kind: "Pod", name: "serviceA-abc", uid: "u1" }, type: "Normal" },
    ];
    expect(matchEventsToServices(events, services, badReasons, ignoreReasons)).toEqual([]);
  });

  it("skips events with reasons on the ignore list, even if also on bad list", () => {
    const ignoreOverlap = new Set(["OOMKilled"]);
    const events = [
      { reason: "OOMKilled", message: "x", lastTimestamp: "2026-04-26T12:00:00Z",
        involvedObject: { kind: "Pod", name: "serviceA-abc", uid: "u1" }, type: "Warning" },
    ];
    expect(matchEventsToServices(events, services, badReasons, ignoreOverlap)).toEqual([]);
  });

  it("skips events for pods not matching any registered service", () => {
    const events = [
      { reason: "OOMKilled", message: "x", lastTimestamp: "2026-04-26T12:00:00Z",
        involvedObject: { kind: "Pod", name: "kube-proxy-abc", uid: "u1" }, type: "Warning" },
    ];
    expect(matchEventsToServices(events, services, badReasons, ignoreReasons)).toEqual([]);
  });

  it("uses longest-prefix match for pod-hash suffixes", () => {
    const longSvcs = new Set(["serviceA", "serviceA-cluster-agent"]);
    const events = [
      { reason: "OOMKilled", message: "x", lastTimestamp: "2026-04-26T12:00:00Z",
        involvedObject: { kind: "Pod", name: "serviceA-cluster-agent-7f8-xyz", uid: "u1" }, type: "Warning" },
    ];
    const hits = matchEventsToServices(events, longSvcs, badReasons, ignoreReasons);
    expect(hits[0]?.service).toBe("serviceA-cluster-agent");
  });
});

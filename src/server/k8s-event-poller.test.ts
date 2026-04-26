import { describe, it, expect, vi } from "vitest";
import {
  K8sEventPoller,
  matchEventsToServices,
  matchRestartsToServices,
  extractNamespace,
  type K8sEventPollerDeps,
  type K8sEventHit,
  type DegradedReason,
} from "./k8s-event-poller.js";
import { InvestigationDedup } from "./investigation-dedup.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceRegistryStore } from "../services/registry.js";

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

function makeDeps(opts: Partial<K8sEventPollerDeps> = {}): K8sEventPollerDeps {
  return {
    providers: opts.providers ?? [],
    registryStore: opts.registryStore ?? makeRegistryStore(),
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

  it("skips events whose involvedObject is not a Pod (e.g. Deployment, Node)", () => {
    const events = [
      { reason: "OOMKilled", message: "x", lastTimestamp: "2026-04-26T12:00:00Z",
        involvedObject: { kind: "Deployment", name: "serviceA", uid: "u1" }, type: "Warning" },
      { reason: "OOMKilled", message: "x", lastTimestamp: "2026-04-26T12:00:00Z",
        involvedObject: { kind: "Node", name: "serviceA-worker-1", uid: "u2" }, type: "Warning" },
    ];
    expect(matchEventsToServices(events, services, badReasons, ignoreReasons)).toEqual([]);
  });
});

describe("matchRestartsToServices", () => {
  const services = new Set(["svcA"]);

  function makePod(uid: string, ownerName: string, statuses: Array<{ name: string; restartCount: number; finishedAt?: string; reason?: string; message?: string }>) {
    return {
      metadata: { uid, namespace: "ns1", ownerReferences: [{ kind: "ReplicaSet", name: ownerName }] },
      status: {
        containerStatuses: statuses.map((s) => ({
          name: s.name,
          restartCount: s.restartCount,
          lastState: s.finishedAt ? { terminated: { reason: s.reason, message: s.message, finishedAt: s.finishedAt } } : {},
        })),
      },
    };
  }

  it("first poll seeds cache, fires no hits", () => {
    const cache = new Map<string, number>();
    const pods = [makePod("u1", "svcA-7f8c", [{ name: "main", restartCount: 0 }])];
    const hits = matchRestartsToServices(pods, services, cache);
    expect(hits).toEqual([]);
    expect(cache.get("u1:main")).toBe(0);
  });

  it("emits hit when restartCount increments", () => {
    const cache = new Map<string, number>([["u1:main", 0]]);
    const pods = [makePod("u1", "svcA-7f8c",
      [{ name: "main", restartCount: 1, finishedAt: "2026-04-26T12:00:00Z", reason: "Error", message: "boom" }],
    )];
    const hits = matchRestartsToServices(pods, services, cache);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      service: "svcA",
      podUid: "u1",
      restartCount: 1,
      source: "restart-count",
      reason: "Error",
    });
    expect(cache.get("u1:main")).toBe(1);
  });

  it("no hit when restartCount unchanged", () => {
    const cache = new Map<string, number>([["u1:main", 1]]);
    const pods = [makePod("u1", "svcA-7f8c", [{ name: "main", restartCount: 1 }])];
    expect(matchRestartsToServices(pods, services, cache)).toEqual([]);
  });

  it("no hit when restartCount decreased (pod recreated)", () => {
    const cache = new Map<string, number>([["u1:main", 5]]);
    const pods = [makePod("u1", "svcA-7f8c", [{ name: "main", restartCount: 0 }])];
    expect(matchRestartsToServices(pods, services, cache)).toEqual([]);
    expect(cache.get("u1:main")).toBe(0);
  });

  it("GCs cache entries for pod UIDs no longer present", () => {
    const cache = new Map<string, number>([
      ["u1:main", 0],
      ["u-gone:main", 3],
    ]);
    const pods = [makePod("u1", "svcA-7f8c", [{ name: "main", restartCount: 0 }])];
    matchRestartsToServices(pods, services, cache);
    expect(cache.has("u-gone:main")).toBe(false);
  });

  it("skips pods not mapped to a registered service", () => {
    const cache = new Map<string, number>();
    const pods = [makePod("u1", "kube-proxy-abc", [{ name: "main", restartCount: 5 }])];
    expect(matchRestartsToServices(pods, services, cache)).toEqual([]);
  });
});

function makeContentToolResult(json: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

describe("K8sEventPoller.poll orchestration", () => {
  it("emits onK8sEvent for OOMKilled on a registered service", async () => {
    const eventsExecute = vi.fn().mockResolvedValue(makeContentToolResult({
      items: [{
        reason: "OOMKilled",
        message: "killed",
        lastTimestamp: "2026-04-26T12:00:00Z",
        involvedObject: { kind: "Pod", name: "svcA-abc-xyz", uid: "u1" },
        type: "Warning",
      }],
    }));
    const podsExecute = vi.fn().mockResolvedValue(makeContentToolResult({ items: [] }));
    const provider = makeProvider({
      list_events: { execute: eventsExecute },
      list_pods: { execute: podsExecute },
    });
    const seen: K8sEventHit[] = [];
    const poller = new K8sEventPoller(makeDeps({
      providers: [provider],
      registryStore: makeRegistryStore([{ name: "svcA", logLabels: { namespace: "ns1" } }]),
      onK8sEvent: (h) => seen.push(h),
    }));
    await poller.poll();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ service: "svcA", reason: "OOMKilled", source: "event" });
    expect(poller.getRecentHits(10)).toHaveLength(1);
  });

  it("does not emit when service is hidden", async () => {
    const provider = makeProvider({
      list_events: { execute: vi.fn().mockResolvedValue(makeContentToolResult({
        items: [{ reason: "OOMKilled", involvedObject: { kind: "Pod", name: "svcA-abc", uid: "u1" }, type: "Warning", lastTimestamp: "2026-04-26T12:00:00Z" }],
      })) },
      list_pods: { execute: vi.fn().mockResolvedValue(makeContentToolResult({ items: [] })) },
    });
    const seen: K8sEventHit[] = [];
    const poller = new K8sEventPoller(makeDeps({
      providers: [provider],
      registryStore: makeRegistryStore([{ name: "svcA", logLabels: { namespace: "ns1" } }]),
      getHiddenServices: () => new Set(["svcA"]),
      onK8sEvent: (h) => seen.push(h),
    }));
    await poller.poll();
    expect(seen).toEqual([]);
  });

  it("skips services without a derivable namespace and logs nothing fatal", async () => {
    const eventsExecute = vi.fn().mockResolvedValue(makeContentToolResult({ items: [] }));
    const podsExecute = vi.fn().mockResolvedValue(makeContentToolResult({ items: [] }));
    const provider = makeProvider({
      list_events: { execute: eventsExecute },
      list_pods: { execute: podsExecute },
    });
    const poller = new K8sEventPoller(makeDeps({
      providers: [provider],
      registryStore: makeRegistryStore([{ name: "svcA", logLabels: {} }]),
    }));
    await poller.poll();
    expect(poller.getDegradedReason()).toBeNull();
  });

  it("caps at maxEventsPerTick and warn-logs", async () => {
    const manyEvents = Array.from({ length: 150 }, (_, i) => ({
      reason: "OOMKilled",
      lastTimestamp: `2026-04-26T12:00:${String(i % 60).padStart(2, "0")}Z`,
      involvedObject: { kind: "Pod", name: `svcA-${i}`, uid: `u${i}` },
      type: "Warning",
    }));
    const provider = makeProvider({
      list_events: { execute: vi.fn().mockResolvedValue(makeContentToolResult({ items: manyEvents })) },
      list_pods: { execute: vi.fn().mockResolvedValue(makeContentToolResult({ items: [] })) },
    });
    const seen: K8sEventHit[] = [];
    const poller = new K8sEventPoller(makeDeps({
      providers: [provider],
      registryStore: makeRegistryStore([{ name: "svcA", logLabels: { namespace: "ns1" } }]),
      onK8sEvent: (h) => seen.push(h),
      config: {
        enabled: true, intervalSeconds: 300,
        badReasons: ["OOMKilled"], ignoreReasons: [],
        maxEventsPerTick: 50, queryTimeoutMs: 15_000,
      },
    }));
    await poller.poll();
    expect(seen.length).toBe(50);
  });

  it("infrastructure-call-failed when tool call throws", async () => {
    const provider = makeProvider({
      list_events: { execute: vi.fn().mockRejectedValue(new Error("MCP down")) },
      list_pods: { execute: vi.fn().mockResolvedValue(makeContentToolResult({ items: [] })) },
    });
    const poller = new K8sEventPoller(makeDeps({
      providers: [provider],
      registryStore: makeRegistryStore([{ name: "svcA", logLabels: { namespace: "ns1" } }]),
    }));
    await poller.poll();
    expect(poller.getDegradedReason()).toBe("infrastructure-call-failed");
  });
});

describe("extractNamespace", () => {
  it("reads logLabels.namespace", () => {
    expect(extractNamespace({ name: "x", logLabels: { namespace: "ns1" } } as any)).toBe("ns1");
  });
  it("falls back to logLabels.kubernetes_namespace", () => {
    expect(extractNamespace({ name: "x", logLabels: { kubernetes_namespace: "ns2" } } as any)).toBe("ns2");
  });
  it("falls back to logLabels.k8s_namespace", () => {
    expect(extractNamespace({ name: "x", logLabels: { k8s_namespace: "ns3" } } as any)).toBe("ns3");
  });
  it("returns undefined when no namespace key present", () => {
    expect(extractNamespace({ name: "x", logLabels: { app: "x" } } as any)).toBeUndefined();
  });
  it("returns undefined when logLabels missing", () => {
    expect(extractNamespace({ name: "x" } as any)).toBeUndefined();
  });
});

describe("K8sEventPoller dedup interaction", () => {
  it("never both fires when a sibling detector already markStarted'd the same service", () => {
    const dedup = new InvestigationDedup({ dedupWindowSeconds: 300, maxConcurrent: 3 });
    // Sibling detector took the lock first.
    expect(dedup.shouldInvestigate("stack1", "svcA").allowed).toBe(true);
    dedup.markStarted("stack1", "svcA");

    // K8s poller arrives second on the same tick.
    expect(dedup.shouldInvestigate("stack1", "svcA").allowed).toBe(false);
  });

  it("re-allows after window expires", () => {
    vi.useFakeTimers();
    const dedup = new InvestigationDedup({ dedupWindowSeconds: 1, maxConcurrent: 3 });
    dedup.markStarted("stack1", "svcA");
    expect(dedup.shouldInvestigate("stack1", "svcA").allowed).toBe(false);
    dedup.markCompleted();
    vi.advanceTimersByTime(1100);
    expect(dedup.shouldInvestigate("stack1", "svcA").allowed).toBe(true);
    vi.useRealTimers();
  });
});

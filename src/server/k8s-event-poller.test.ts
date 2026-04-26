import { describe, it, expect, vi } from "vitest";
import {
  K8sEventPoller,
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

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ServiceHealthPoller,
  parsePrometheusResult,
  matchResultsToServices,
  type HealthStatus,
  type ServiceHealthPollerDeps,
} from "./service-health-poller.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { Database } from "./db.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePrometheusEntry(
  labels: Record<string, string>,
  value = "1",
): object {
  return {
    metric: labels,
    value: [Date.now() / 1000, value],
  };
}

function makeProvider(
  name: string,
  toolMap: Record<string, { execute: (args: unknown) => Promise<unknown> }> = {},
): MastraProvider {
  const client = {
    listTools: vi.fn().mockResolvedValue(toolMap),
  } as unknown as MastraProvider["client"];
  return { name, roles: ["metrics"], client };
}

function makeRegistryStore(services: string[]): ServiceRegistryStore {
  return {
    load: vi.fn().mockReturnValue(
      services.map((name) => ({ name, metrics: [], logLabels: {} })),
    ),
  } as unknown as ServiceRegistryStore;
}

function makeDb(history: Array<{ status: string; checked_at: string }> = []): Database {
  return {
    migrateServiceHealthChecks: vi.fn(),
    insertServiceHealthCheck: vi.fn(),
    getServiceHealthHistory: vi.fn().mockReturnValue(history),
  } as unknown as Database;
}

/**
 * Build a poller with mocked deps. The `queryResults` map controls what each
 * query string returns from the fake query_prometheus tool.
 */
function makePoller(
  services: string[],
  queryResults: Record<string, unknown[]>,
  opts: Partial<ServiceHealthPollerDeps> = {},
): { poller: ServiceHealthPoller; db: Database; transitions: Array<[string, HealthStatus, HealthStatus]> } {
  const transitions: Array<[string, HealthStatus, HealthStatus]> = [];

  const queryTool = {
    execute: vi.fn(async (args: unknown) => {
      const { expr } = args as { expr: string };
      const entries = queryResults[expr] ?? [];
      return { data: { result: entries } };
    }),
  };

  const listDatasourcesTool = {
    execute: vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ datasources: [{ uid: "prometheus", name: "Prometheus", type: "prometheus" }] }) }],
    })),
  };
  const provider = makeProvider("prom", { prom_query_prometheus: queryTool, prom_list_datasources: listDatasourcesTool });
  // Patch listTools to return the tools directly so getAllTools picks them up
  (provider.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
    prom_query_prometheus: queryTool,
    prom_list_datasources: listDatasourcesTool,
  });

  const db = makeDb();
  const registryStore = makeRegistryStore(services);

  const poller = new ServiceHealthPoller({
    providers: [provider],
    registryStore,
    db,
    intervalMs: 999_999, // never fires automatically in tests
    onTransition: (svc, from, to) => transitions.push([svc, from, to]),
    ...opts,
  });

  return { poller, db, transitions };
}

// ── parsePrometheusResult ─────────────────────────────────────────────────────

describe("parsePrometheusResult", () => {
  it("returns empty array for null/undefined", () => {
    expect(parsePrometheusResult(null)).toEqual([]);
    expect(parsePrometheusResult(undefined)).toEqual([]);
  });

  it("parses data.result wrapper", () => {
    const result = parsePrometheusResult({
      data: {
        result: [
          { metric: { job: "my-service" }, value: [1, "1"] },
        ],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.metric["job"]).toBe("my-service");
  });

  it("parses flat result wrapper", () => {
    const result = parsePrometheusResult({
      result: [{ metric: { deployment: "api" }, value: [1, "2"] }],
    });
    expect(result).toHaveLength(1);
  });

  it("parses direct array", () => {
    const result = parsePrometheusResult([
      { metric: { job: "svc" }, value: [1, "1"] },
    ]);
    expect(result).toHaveLength(1);
  });

  it("unwraps MCP content wrapper", () => {
    const inner = JSON.stringify({
      data: {
        result: [{ metric: { deployment: "frontend" }, value: [1, "3"] }],
      },
    });
    const result = parsePrometheusResult({
      content: [{ type: "text", text: inner }],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.metric["deployment"]).toBe("frontend");
  });

  it("parses JSON string", () => {
    const str = JSON.stringify({
      data: { result: [{ metric: { job: "svc" }, value: [1, "1"] }] },
    });
    const result = parsePrometheusResult(str);
    expect(result).toHaveLength(1);
  });

  it("returns empty array for invalid JSON string", () => {
    expect(parsePrometheusResult("not-json")).toEqual([]);
  });

  it("returns empty array for malformed content wrapper", () => {
    expect(parsePrometheusResult({ content: [] })).toEqual([]);
  });
});

// ── matchResultsToServices ────────────────────────────────────────────────────

describe("matchResultsToServices", () => {
  it("matches by deployment label — exact match", () => {
    const entries = [makePrometheusEntry({ deployment: "api-service" }, "2")];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["api-service"]),
      "unknown",
    );
    expect(result.get("api-service")).toBe("healthy");
  });

  it("matches by deployment label — prefix match", () => {
    const entries = [makePrometheusEntry({ deployment: "api-service-7d9f4" }, "1")];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["api-service"]),
      "unknown",
    );
    expect(result.get("api-service")).toBe("healthy");
  });

  it("matches by statefulset label", () => {
    const entries = [makePrometheusEntry({ statefulset: "postgres" }, "1")];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["postgres"]),
      "unknown",
    );
    expect(result.get("postgres")).toBe("healthy");
  });

  it("matches by daemonset label", () => {
    const entries = [makePrometheusEntry({ daemonset: "node-exporter" }, "6")];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["node-exporter"]),
      "unknown",
    );
    expect(result.get("node-exporter")).toBe("healthy");
  });

  it("matches by job label", () => {
    const entries = [makePrometheusEntry({ job: "prometheus" }, "1")];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["prometheus"]),
      "down",
    );
    expect(result.get("prometheus")).toBe("healthy");
  });

  it("value=0 with zeroMeans=unknown → unknown (replicas semantics)", () => {
    const entries = [makePrometheusEntry({ deployment: "scaled-down" }, "0")];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["scaled-down"]),
      "unknown",
    );
    expect(result.get("scaled-down")).toBe("unknown");
  });

  it("value=0 with zeroMeans=down → down (up semantics)", () => {
    const entries = [makePrometheusEntry({ job: "dead-target" }, "0")];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["dead-target"]),
      "down",
    );
    expect(result.get("dead-target")).toBe("down");
  });

  it("NaN / missing value → unknown regardless of zeroMeans", () => {
    const entries = [{ metric: { deployment: "api" }, value: [Date.now() / 1000, "NaN"] }];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["api"]),
      "down",
    );
    expect(result.get("api")).toBe("unknown");
  });

  it("does not downgrade healthy when a 0-value entry follows", () => {
    const entries = [
      makePrometheusEntry({ deployment: "api-service" }, "3"), // healthy
      makePrometheusEntry({ job: "api-service" }, "0"),         // down — should not override
    ];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["api-service"]),
      "down",
    );
    expect(result.get("api-service")).toBe("healthy");
  });

  it("returns empty map when no service names provided", () => {
    const entries = [makePrometheusEntry({ deployment: "api-service" }, "1")];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(),
      "unknown",
    );
    expect(result.size).toBe(0);
  });

  it("does not match unrelated labels", () => {
    const entries = [makePrometheusEntry({ pod: "some-pod" }, "1")];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["api-service"]),
      "unknown",
    );
    expect(result.has("api-service")).toBe(false);
  });
});

// ── ServiceHealthPoller ───────────────────────────────────────────────────────

describe("ServiceHealthPoller", () => {
  describe("getHealth / getSummary after poll", () => {
    it("marks matched services healthy and unmatched as unknown", async () => {
      const { poller } = makePoller(
        ["api", "db", "cache"],
        {
          "kube_deployment_status_replicas": [
            makePrometheusEntry({ deployment: "api" }, "2"),
            makePrometheusEntry({ deployment: "db" }, "1"),
          ],
          "kube_statefulset_status_replicas": [],
          "up": [],
        },
      );

      await poller.poll();

      const health = poller.getHealth();
      expect(health.get("api")).toBe("healthy");
      expect(health.get("db")).toBe("healthy");
      expect(health.get("cache")).toBe("unknown");

      const summary = poller.getSummary();
      expect(summary.healthy).toBe(2);
      expect(summary.unknown).toBe(1);
      expect(summary.total).toBe(3);
    });

    it("marks service as unknown when replicas = 0 (scaled-down workload is not an outage)", async () => {
      const { poller } = makePoller(
        ["api"],
        {
          "kube_deployment_status_replicas": [
            makePrometheusEntry({ deployment: "api" }, "0"),
          ],
          "kube_statefulset_status_replicas": [],
          "up": [],
        },
      );

      await poller.poll();
      expect(poller.getHealth().get("api")).toBe("unknown");
    });

    it("marks service as down when up = 0 (real scrape failure)", async () => {
      const { poller } = makePoller(
        ["prometheus"],
        {
          "kube_deployment_status_replicas": [],
          "kube_statefulset_status_replicas": [],
          "up": [makePrometheusEntry({ job: "prometheus" }, "0")],
        },
      );

      await poller.poll();
      expect(poller.getHealth().get("prometheus")).toBe("down");
    });

    it("merge priority: healthy (from replicas) wins over down (from up)", async () => {
      const { poller } = makePoller(
        ["api"],
        {
          "kube_deployment_status_replicas": [
            makePrometheusEntry({ deployment: "api" }, "3"),
          ],
          "kube_statefulset_status_replicas": [],
          "up": [makePrometheusEntry({ job: "api" }, "0")],
        },
      );

      await poller.poll();
      expect(poller.getHealth().get("api")).toBe("healthy");
    });

    it("merge priority: down (from up) wins over unknown (from replicas)", async () => {
      const { poller } = makePoller(
        ["api"],
        {
          "kube_deployment_status_replicas": [
            makePrometheusEntry({ deployment: "api" }, "0"),
          ],
          "kube_statefulset_status_replicas": [],
          "up": [makePrometheusEntry({ job: "api" }, "0")],
        },
      );

      await poller.poll();
      expect(poller.getHealth().get("api")).toBe("down");
    });

    it("uses up results when deployment queries have no match", async () => {
      const { poller } = makePoller(
        ["prometheus"],
        {
          "kube_deployment_status_replicas": [],
          "kube_statefulset_status_replicas": [],
          "up": [makePrometheusEntry({ job: "prometheus" }, "1")],
        },
      );

      await poller.poll();
      expect(poller.getHealth().get("prometheus")).toBe("healthy");
    });

    it("returns empty health when no services are registered", async () => {
      const { poller } = makePoller([], {});
      await poller.poll();
      expect(poller.getHealth().size).toBe(0);
      expect(poller.getSummary()).toEqual({ healthy: 0, degraded: 0, down: 0, unknown: 0, total: 0 });
    });
  });

  describe("transition detection", () => {
    it("fires onTransition when a healthy service later reports replicas=0 (healthy → unknown)", async () => {
      const { poller, transitions } = makePoller(
        ["api"],
        {
          "kube_deployment_status_replicas": [makePrometheusEntry({ deployment: "api" }, "2")],
          "kube_statefulset_status_replicas": [],
          "up": [],
        },
      );

      // First poll — no previous status, healthy → no transition
      await poller.poll();
      expect(transitions).toHaveLength(0);

      // Second poll — simulate service being scaled down by replacing query results
      const queryTool = (poller as unknown as {
        resolveProviders: () => MastraProvider[];
      }).resolveProviders()[0]!.client.listTools as ReturnType<typeof vi.fn>;
      queryTool.mockResolvedValue({
        prom_query_prometheus: {
          execute: vi.fn(async (args: unknown) => {
            const { expr } = args as { expr: string };
            // Only replicas reports 0 — up returns nothing
            if (expr === "kube_deployment_status_replicas") {
              return { data: { result: [makePrometheusEntry({ deployment: "api" }, "0")] } };
            }
            return { data: { result: [] } };
          }),
        },
      });

      await poller.poll();
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual(["api", "healthy", "unknown"]);
    });

    it("fires onTransition when a healthy service later reports up=0 (healthy → down)", async () => {
      const { poller, transitions } = makePoller(
        ["api"],
        {
          "kube_deployment_status_replicas": [],
          "kube_statefulset_status_replicas": [],
          "up": [makePrometheusEntry({ job: "api" }, "1")],
        },
      );

      await poller.poll();
      expect(transitions).toHaveLength(0);

      const queryTool = (poller as unknown as {
        resolveProviders: () => MastraProvider[];
      }).resolveProviders()[0]!.client.listTools as ReturnType<typeof vi.fn>;
      queryTool.mockResolvedValue({
        prom_query_prometheus: {
          execute: vi.fn(async (args: unknown) => {
            const { expr } = args as { expr: string };
            if (expr === "up") {
              return { data: { result: [makePrometheusEntry({ job: "api" }, "0")] } };
            }
            return { data: { result: [] } };
          }),
        },
      });

      await poller.poll();
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual(["api", "healthy", "down"]);
    });

    it("does NOT fire onTransition on first poll when a service has replicas=0 (scaled-down is not a failure)", async () => {
      const { poller, transitions } = makePoller(
        ["scaled-down-svc"],
        {
          "kube_deployment_status_replicas": [
            makePrometheusEntry({ deployment: "scaled-down-svc" }, "0"),
          ],
          "kube_statefulset_status_replicas": [],
          "up": [],
        },
      );

      await poller.poll();
      expect(transitions).toHaveLength(0);
      expect(poller.getHealth().get("scaled-down-svc")).toBe("unknown");
    });

    it("DOES fire onTransition on first poll when up=0 (regression test: commit 72fa3de)", async () => {
      const { poller, transitions } = makePoller(
        ["real-outage"],
        {
          "kube_deployment_status_replicas": [],
          "kube_statefulset_status_replicas": [],
          "up": [makePrometheusEntry({ job: "real-outage" }, "0")],
        },
      );

      await poller.poll();
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual(["real-outage", "unknown", "down"]);
    });

    it("does not fire onTransition when status is unchanged", async () => {
      const { poller, transitions } = makePoller(
        ["api"],
        {
          "kube_deployment_status_replicas": [makePrometheusEntry({ deployment: "api" }, "2")],
          "kube_statefulset_status_replicas": [],
          "up": [],
        },
      );

      await poller.poll();
      await poller.poll(); // same results
      expect(transitions).toHaveLength(0);
    });
  });

  describe("persistence", () => {
    it("calls insertServiceHealthCheck for each service", async () => {
      const { poller, db } = makePoller(
        ["api", "db"],
        {
          "kube_deployment_status_replicas": [
            makePrometheusEntry({ deployment: "api" }, "1"),
          ],
          "kube_statefulset_status_replicas": [],
          "up": [],
        },
      );

      await poller.poll();

      expect(db.insertServiceHealthCheck).toHaveBeenCalledTimes(2);
      expect(db.insertServiceHealthCheck).toHaveBeenCalledWith("", "api", "healthy", expect.any(String));
      expect(db.insertServiceHealthCheck).toHaveBeenCalledWith("", "db", "unknown", expect.any(String));
    });

    it("calls migrateServiceHealthChecks on start()", () => {
      const { poller, db } = makePoller(["api"], {
        "kube_deployment_status_replicas": [],
        "kube_statefulset_status_replicas": [],
        "up": [],
      });

      poller.stop(); // stop before the interval fires
      // start() synchronously calls ensureMigrated
      poller.start();
      poller.stop();

      expect(db.migrateServiceHealthChecks).toHaveBeenCalledTimes(1);
    });
  });

  describe("getHistory", () => {
    it("returns DB history for the service", () => {
      const history = [
        { status: "healthy", checked_at: "2024-01-01T00:00:00.000Z" },
        { status: "down", checked_at: "2024-01-01T01:00:00.000Z" },
      ];
      const db = makeDb(history);
      const poller = new ServiceHealthPoller({
        providers: [],
        registryStore: makeRegistryStore([]),
        db,
      });

      const result = poller.getHistory("api", 24);
      expect(result).toEqual(history);
      expect(db.getServiceHealthHistory).toHaveBeenCalledWith("", "api", 24);
    });

    it("returns empty array when DB throws", () => {
      const db = makeDb();
      (db.getServiceHealthHistory as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB error");
      });

      const poller = new ServiceHealthPoller({
        providers: [],
        registryStore: makeRegistryStore([]),
        db,
      });

      expect(poller.getHistory("api", 24)).toEqual([]);
    });
  });

  describe("graceful failure", () => {
    it("keeps last known health when MCP tool call fails", async () => {
      const failingTool = {
        execute: vi.fn()
          .mockResolvedValueOnce({ data: { result: [makePrometheusEntry({ deployment: "api" }, "1")] } })
          .mockResolvedValueOnce({ data: { result: [] } })
          .mockResolvedValueOnce({ data: { result: [] } })
          // Second poll — all queries throw
          .mockRejectedValue(new Error("Prometheus unavailable")),
      };

      const provider = makeProvider("prom", {});
      (provider.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
        prom_query_prometheus: failingTool,
      });

      const db = makeDb();
      const registryStore = makeRegistryStore(["api"]);
      const poller = new ServiceHealthPoller({ providers: [provider], registryStore, db });

      // First poll succeeds
      await poller.poll();
      expect(poller.getHealth().get("api")).toBe("healthy");

      // Second poll — MCP fails entirely (getAllTools throws)
      (provider.client.listTools as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("MCP connection lost"),
      );
      await poller.poll();

      // Health should remain at last known state
      expect(poller.getHealth().get("api")).toBe("healthy");
    });

    it("does not throw when getAllTools returns no query_prometheus tool", async () => {
      const provider = makeProvider("prom", {});
      (provider.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
        prom_some_other_tool: { execute: vi.fn() },
      });

      const poller = new ServiceHealthPoller({
        providers: [provider],
        registryStore: makeRegistryStore(["api"]),
        db: makeDb(),
      });

      await expect(poller.poll()).resolves.toBeUndefined();
    });

    it("does not throw when insertServiceHealthCheck fails", async () => {
      const db = makeDb();
      (db.insertServiceHealthCheck as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB write failed");
      });
      (db.migrateServiceHealthChecks as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      const { poller } = makePoller(
        ["api"],
        {
          "kube_deployment_status_replicas": [makePrometheusEntry({ deployment: "api" }, "1")],
          "kube_statefulset_status_replicas": [],
          "up": [],
        },
        { db },
      );

      await expect(poller.poll()).resolves.toBeUndefined();
    });
  });

  describe("start / stop", () => {
    it("stop clears the interval", () => {
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const { poller } = makePoller([], {});

      poller.start();
      poller.stop();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      clearIntervalSpy.mockRestore();
    });

    it("stop is idempotent (no error when called twice)", () => {
      const { poller } = makePoller([], {});
      poller.start();
      poller.stop();
      expect(() => poller.stop()).not.toThrow();
    });
  });

  describe("hidden services", () => {
    it("skips hidden services during poll", async () => {
      const { poller, db } = makePoller(
        ["api", "hidden-svc"],
        {
          "kube_deployment_status_replicas": [
            makePrometheusEntry({ deployment: "api" }, "1"),
            makePrometheusEntry({ deployment: "hidden-svc" }, "1"),
          ],
          "kube_statefulset_status_replicas": [],
          "up": [],
        },
        { getHiddenServices: () => new Set(["hidden-svc"]) },
      );

      await poller.poll();
      const health = poller.getHealth();
      expect(health.has("api")).toBe(true);
      expect(health.has("hidden-svc")).toBe(false);
    });

    it("polls all services when none hidden", async () => {
      const { poller } = makePoller(
        ["api", "web"],
        {
          "kube_deployment_status_replicas": [
            makePrometheusEntry({ deployment: "api" }, "1"),
            makePrometheusEntry({ deployment: "web" }, "1"),
          ],
          "kube_statefulset_status_replicas": [],
          "up": [],
        },
        { getHiddenServices: () => new Set() },
      );

      await poller.poll();
      expect(poller.getHealth().size).toBe(2);
    });
  });

  describe("getSummary", () => {
    it("returns correct counts for mixed statuses", async () => {
      const { poller } = makePoller(
        ["a", "b", "c", "d"],
        {
          "kube_deployment_status_replicas": [
            makePrometheusEntry({ deployment: "a" }, "1"), // healthy
          ],
          "kube_statefulset_status_replicas": [],
          "up": [
            makePrometheusEntry({ job: "b" }, "0"), // real scrape failure → down
          ],
          // c and d → unknown (no matching entries)
        },
      );

      await poller.poll();
      const summary = poller.getSummary();
      expect(summary.healthy).toBe(1);
      expect(summary.down).toBe(1);
      expect(summary.unknown).toBe(2);
      expect(summary.degraded).toBe(0);
      expect(summary.total).toBe(4);
    });
  });
});

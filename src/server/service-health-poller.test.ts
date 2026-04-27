import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ServiceHealthPoller,
  parsePrometheusResult,
  matchResultsToServices,
  severityForStatus,
  type HealthStatus,
  type ServiceHealthPollerDeps,
} from "./service-health-poller.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { Database } from "./db.js";
import { eventLog } from "./event-log.js";

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

  it("prefers exact match over prefix match when both would apply", () => {
    // Regression: previously "coroot-web-cluster-agent" deployment entry matched
    // "coroot-web" via prefix match because Set.find() returned the first-inserted
    // matching name. The longer service name never got its own status assigned.
    const entries = [
      makePrometheusEntry({ deployment: "coroot-web" }, "1"),
      makePrometheusEntry({ deployment: "coroot-web-cluster-agent" }, "1"),
      makePrometheusEntry({ deployment: "coroot-web-node-agent-abc123" }, "1"), // should still prefix-match
    ];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["coroot-web", "coroot-web-cluster-agent", "coroot-web-node-agent"]),
      "unknown",
    );
    expect(result.get("coroot-web")).toBe("healthy");
    expect(result.get("coroot-web-cluster-agent")).toBe("healthy");
    expect(result.get("coroot-web-node-agent")).toBe("healthy");
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

  it("matches on 'app' label (services discovered via up{app=...} queries)", () => {
    // Regression: the default stack's services use `up{app="admin-daphne"}`-style
    // queries. Prometheus returns `up` entries with an `app` label, not
    // `deployment`/`job`/`service`. Before this fix, the poller could not match
    // those entries to service names and reported them as unknown.
    const entries = [
      makePrometheusEntry({ app: "admin-daphne" }, "1"),
      makePrometheusEntry({ app: "admin-nginx" }, "1"),
    ];
    const result = matchResultsToServices(
      entries as ReturnType<typeof makePrometheusEntry>[],
      new Set(["admin-daphne", "admin-nginx"]),
      "down",
    );
    expect(result.get("admin-daphne")).toBe("healthy");
    expect(result.get("admin-nginx")).toBe("healthy");
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

    it("marks service as down when replicas = 0 (scaled-down workload surfaces as DOWN in the UI)", async () => {
      // After the B-minus change, replicas=0 classifies as "down" so the UI
      // matches operator intuition ("I turned this off" → DOWN). The poller
      // separately suppresses first-poll auto-investigations for this case —
      // see the transition-detection test below.
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
      expect(poller.getHealth().get("api")).toBe("down");
    });

    it("issues all four PromQL queries (deployment, statefulset, daemonset, up) per poll and classifies daemonset matches", async () => {
      // Regression guard: before this test, a test for the daemonset matcher
      // existed but nothing verified that pollOnce actually QUERIED the
      // daemonset metric. Dropping the daemonset entry from the Promise.all
      // would have passed all prior tests.
      const queryResults: Record<string, object[]> = {
        "kube_deployment_status_replicas": [makePrometheusEntry({ deployment: "api" }, "1")],
        "kube_statefulset_status_replicas": [makePrometheusEntry({ statefulset: "postgres" }, "1")],
        "kube_daemonset_status_desired_number_scheduled": [makePrometheusEntry({ daemonset: "node-exporter" }, "6")],
        "up": [makePrometheusEntry({ job: "prom" }, "1")],
      };
      const queryTool = {
        execute: vi.fn(async (args: unknown) => {
          const { expr } = args as { expr: string };
          return { data: { result: queryResults[expr] ?? [] } };
        }),
      };
      const listDatasourcesTool = {
        execute: vi.fn(async () => ({
          content: [{ type: "text", text: JSON.stringify({ datasources: [{ uid: "prometheus", name: "Prometheus", type: "prometheus" }] }) }],
        })),
      };
      const provider = makeProvider("prom", {
        prom_query_prometheus: queryTool,
        prom_list_datasources: listDatasourcesTool,
      });
      (provider.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
        prom_query_prometheus: queryTool,
        prom_list_datasources: listDatasourcesTool,
      });

      const poller = new ServiceHealthPoller({
        providers: [provider],
        registryStore: makeRegistryStore(["node-exporter", "api", "postgres", "prom"]),
        db: makeDb(),
        intervalMs: 999_999,
      });

      await poller.poll();

      const exprs = queryTool.execute.mock.calls.map((c) => (c[0] as { expr: string }).expr);
      expect(exprs).toContain("kube_deployment_status_replicas");
      expect(exprs).toContain("kube_statefulset_status_replicas");
      expect(exprs).toContain("kube_daemonset_status_desired_number_scheduled");
      expect(exprs).toContain("up");

      // DaemonSet service gets classified via the daemonset batch.
      expect(poller.getHealth().get("node-exporter")).toBe("healthy");
      expect(poller.getHealth().get("api")).toBe("healthy");
      expect(poller.getHealth().get("postgres")).toBe("healthy");
      expect(poller.getHealth().get("prom")).toBe("healthy");
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

    it("merge: up=0 and replicas=0 both classify as down (converged on DOWN)", async () => {
      // After B-minus, both zero-path batches produce "down". The merge still
      // prefers "down" over "unknown" and "healthy" wins over everything; the
      // up/replicas distinction is preserved via the separate downViaUp
      // tracker (exercised by the transition-detection tests below).
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
    it("fires onTransition when a healthy service later reports replicas=0 (healthy → down)", async () => {
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
      expect(transitions[0]).toEqual(["api", "healthy", "down"]);
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

    it("does NOT fire onTransition on first poll when a service has replicas=0 (scaled-down shows as DOWN but skips auto-investigation)", async () => {
      // B-minus invariant: a service that's DOWN only because of replicas=0
      // (not up=0) should not auto-fire investigations on server restart.
      // Prevents a stack with N intentionally-scaled-down services from
      // firing N LLM investigations on boot.
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
      expect(poller.getHealth().get("scaled-down-svc")).toBe("down");
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

    it("DOES fire onTransition on first poll when BOTH replicas=0 AND up=0 (up evidence overrides scaled-down silence)", async () => {
      // B-minus invariant: scaled-down silence applies only when the ONLY
      // evidence of DOWN is replicas=0. If up also reports 0 for the same
      // service, that's a real scrape failure — fire the transition.
      const { poller, transitions } = makePoller(
        ["half-broken"],
        {
          "kube_deployment_status_replicas": [
            makePrometheusEntry({ deployment: "half-broken" }, "0"),
          ],
          "kube_statefulset_status_replicas": [],
          "up": [makePrometheusEntry({ job: "half-broken" }, "0")],
        },
      );

      await poller.poll();
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual(["half-broken", "unknown", "down"]);
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

// ── event-log emission ───────────────────────────────────────────────────────

/**
 * Build a poller whose query results change across polls. `pollResults` is a
 * list of {expr → entries} maps; the Nth poll reads from the Nth entry,
 * defaulting to the last entry once exhausted (so a single-element list means
 * "always return this").
 */
function makeMultiPollPoller(opts: {
  services: string[];
  stackId?: string;
  onTransition?: (svc: string, from: HealthStatus, to: HealthStatus) => void;
  pollResults: Array<Record<string, object[]>>;
}): { poller: ServiceHealthPoller; advance: () => void } {
  let pollIndex = 0;
  const advance = () => { pollIndex += 1; };

  const queryTool = {
    execute: vi.fn(async (args: unknown) => {
      const { expr } = args as { expr: string };
      const slice = opts.pollResults[Math.min(pollIndex, opts.pollResults.length - 1)] ?? {};
      return { data: { result: slice[expr] ?? [] } };
    }),
  };
  const listDatasourcesTool = {
    execute: vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ datasources: [{ uid: "prometheus", name: "Prometheus", type: "prometheus" }] }) }],
    })),
  };
  const provider = makeProvider("prom", { prom_query_prometheus: queryTool, prom_list_datasources: listDatasourcesTool });
  (provider.client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue({
    prom_query_prometheus: queryTool,
    prom_list_datasources: listDatasourcesTool,
  });

  const poller = new ServiceHealthPoller({
    providers: [provider],
    registryStore: makeRegistryStore(opts.services),
    db: makeDb(),
    stackId: opts.stackId ?? "",
    intervalMs: 999_999,
    onTransition: opts.onTransition,
  });

  return { poller, advance };
}

describe("event-log emission", () => {
  beforeEach(() => {
    eventLog.reset();
  });

  it("emits service_health_changed on healthy → down with severity=error", async () => {
    const { poller, advance } = makeMultiPollPoller({
      services: ["api"],
      stackId: "stack-test",
      pollResults: [
        // Poll 1: healthy.
        {
          kube_deployment_status_replicas: [makePrometheusEntry({ deployment: "api" }, "1")],
          up: [makePrometheusEntry({ job: "api" }, "1")],
        },
        // Poll 2: up=0 → DOWN via downViaUp. Replicas batch is empty so the
        // healthy-from-replicas merge doesn't shadow the up-batch DOWN verdict.
        {
          up: [makePrometheusEntry({ job: "api" }, "0")],
        },
      ],
    });

    await poller.poll();   // healthy
    advance();
    eventLog.reset();      // discard first-poll noise (we're testing the transition only)
    await poller.poll();   // down

    const { events } = eventLog.recent(10);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("service_health_changed");
    expect(ev.severity).toBe("error");
    expect(ev.summary).toContain("api");
    expect(ev.summary).toContain("healthy");
    expect(ev.summary).toContain("down");
    expect(ev.stackId).toBe("stack-test");
    expect(ev.service).toBe("api");
    expect(ev.href).toBe("/services/api");
    expect(ev.meta).toEqual({ from: "healthy", to: "down" });
  });

  it("emits service_health_changed on down → healthy with severity=success", async () => {
    const { poller, advance } = makeMultiPollPoller({
      services: ["api"],
      stackId: "stack-test",
      pollResults: [
        // Poll 1: down via up=0. Replicas batch empty so healthy-from-replicas
        // doesn't shadow the up-batch DOWN verdict.
        {
          up: [makePrometheusEntry({ job: "api" }, "0")],
        },
        // Poll 2: healthy.
        {
          kube_deployment_status_replicas: [makePrometheusEntry({ deployment: "api" }, "1")],
          up: [makePrometheusEntry({ job: "api" }, "1")],
        },
      ],
    });

    await poller.poll();   // first poll: down (via up=0)
    advance();
    eventLog.reset();
    await poller.poll();   // second poll: healthy

    const { events } = eventLog.recent(10);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("success");
    expect(events[0]!.meta).toEqual({ from: "down", to: "healthy" });
  });

  it("does NOT emit on first-poll when only signal is replicas=0 (scaled-down workload)", async () => {
    const { poller } = makeMultiPollPoller({
      services: ["api"],
      stackId: "stack-test",
      pollResults: [
        {
          kube_deployment_status_replicas: [makePrometheusEntry({ deployment: "api" }, "0")],
        },
      ],
    });

    await poller.poll();

    const { events } = eventLog.recent(10);
    expect(events).toHaveLength(0);
  });

  it("emits on first-poll when up=0 (real scrape failure, in downViaUp)", async () => {
    const { poller } = makeMultiPollPoller({
      services: ["api"],
      stackId: "stack-test",
      pollResults: [
        {
          up: [makePrometheusEntry({ job: "api" }, "0")],
        },
      ],
    });

    await poller.poll();

    const { events } = eventLog.recent(10);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("service_health_changed");
    expect(events[0]!.severity).toBe("error");
    expect(events[0]!.meta).toEqual({ from: "unknown", to: "down" });
  });

  it("does not emit when status is unchanged across polls", async () => {
    const { poller } = makeMultiPollPoller({
      services: ["api"],
      stackId: "stack-test",
      pollResults: [
        // Single entry: same result for both polls (helper repeats the last entry).
        {
          kube_deployment_status_replicas: [makePrometheusEntry({ deployment: "api" }, "1")],
          up: [makePrometheusEntry({ job: "api" }, "1")],
        },
      ],
    });

    await poller.poll();
    eventLog.reset();
    await poller.poll();

    const { events } = eventLog.recent(10);
    expect(events).toHaveLength(0);
  });

  it("emits the event even when onTransition throws", async () => {
    const { poller } = makeMultiPollPoller({
      services: ["api"],
      stackId: "stack-test",
      onTransition: () => { throw new Error("boom"); },
      pollResults: [
        {
          up: [makePrometheusEntry({ job: "api" }, "0")],
        },
      ],
    });

    await poller.poll();

    const { events } = eventLog.recent(10);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("service_health_changed");
  });
});

describe("severityForStatus", () => {
  it("maps each health status to the correct severity", () => {
    expect(severityForStatus("down")).toBe("error");
    expect(severityForStatus("degraded")).toBe("warn");
    expect(severityForStatus("healthy")).toBe("success");
    expect(severityForStatus("unknown")).toBe("info");
  });
});

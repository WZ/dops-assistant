import { describe, it, expect, vi } from "vitest";
import { runValidateStep } from "./validate.js";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig } from "../../config/schema.js";

// Mock getToolsByRole so we can inject a scripted MCP execute() per role.
let scriptedMetricsTool: { execute: ReturnType<typeof vi.fn> } | null = null;
vi.mock("../../mcp/provider.js", async () => {
  const actual = await vi.importActual<typeof import("../../mcp/provider.js")>("../../mcp/provider.js");
  return {
    ...actual,
    getToolsByRole: async (_providers: unknown, role: string) => {
      if (role === "metrics" && scriptedMetricsTool) {
        return { query_prometheus: scriptedMetricsTool };
      }
      return {};
    },
  };
});

const providers: MastraProvider[] = []; // not used — getToolsByRole is mocked

function promNonEmpty(value: number): string {
  return JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [Date.now() / 1000, String(value)] }] } });
}
const PROM_EMPTY = JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } });

function buildService(name: string, firstQuery: string, withAvailabilityRule: boolean): ServiceConfig {
  return {
    name,
    metrics: [{ query: firstQuery, description: "" }],
    logLabels: {},
    probeRules: withAvailabilityRule
      ? [{ name: "service_availability", query: firstQuery, threshold: { op: "lt", value: 1 }, consecutiveTicks: 3, source: "metrics" }]
      : [],
  } as ServiceConfig;
}

describe("runValidateStep — metric fallback when agent's pick returns empty", () => {
  it("repairs metrics[0] to a working candidate and updates the paired service_availability rule", async () => {
    // Original query returns empty (simulating the real-world pattern
    // where the agent writes consul_health_service_status for a
    // service not actually in Consul). Second candidate in the fallback
    // list — kube_statefulset_status_replicas_ready — returns data.
    const execute = vi.fn(async ({ expr }: { expr: string }) => {
      if (expr.includes("consul_health_service_status")) return PROM_EMPTY;
      if (expr.includes("kube_deployment_status_replicas_available")) return PROM_EMPTY;
      if (expr.includes("kube_statefulset_status_replicas_ready")) return promNonEmpty(3);
      return PROM_EMPTY;
    });
    scriptedMetricsTool = { execute };

    const svc = buildService("hdfs-namenode", 'consul_health_service_status{service_name="hdfs-namenode"}', true);
    const result = await runValidateStep({ providers, services: [svc] });

    expect(result).toHaveLength(1);
    const r = result[0]!;
    // metrics[0] was repaired.
    expect(r.metrics[0]?.query).toBe('kube_statefulset_status_replicas_ready{statefulset="hdfs-namenode"}');
    // service_availability rule was kept in sync.
    const availRule = (r.probeRules ?? []).find((x) => x.name === "service_availability");
    expect(availRule?.query).toBe('kube_statefulset_status_replicas_ready{statefulset="hdfs-namenode"}');
    // Note records the repair.
    expect(r.validationNotes).toMatch(/repaired via fallback/);
    // Confidence is bumped to verified (metricsOk + no logLabels = verified).
    expect(r.confidence).toBe("verified");
  });

  it("strips -headless suffix when choosing the fallback workload selector", async () => {
    const execute = vi.fn(async ({ expr }: { expr: string }) => {
      // All queries with the raw name `bd-management-server-headless` miss;
      // the stripped-name deployment query matches.
      if (expr === 'kube_deployment_status_replicas_available{deployment="bd-management-server"}') {
        return promNonEmpty(2);
      }
      return PROM_EMPTY;
    });
    scriptedMetricsTool = { execute };

    const svc = buildService("bd-management-server-headless", 'up{app="bd-management-server-headless"}', true);
    const result = await runValidateStep({ providers, services: [svc] });

    expect(result[0]?.metrics[0]?.query).toBe('kube_deployment_status_replicas_available{deployment="bd-management-server"}');
  });

  it("keeps the agent's original query when every fallback also returns empty", async () => {
    const execute = vi.fn(async () => PROM_EMPTY);
    scriptedMetricsTool = { execute };

    const original = 'consul_health_service_status{service_name="genuinely-broken"}';
    const svc = buildService("genuinely-broken", original, true);
    const result = await runValidateStep({ providers, services: [svc] });

    expect(result[0]?.metrics[0]?.query).toBe(original);
    // Rule stays unchanged too — no silent substitution.
    const availRule = (result[0]?.probeRules ?? []).find((x) => x.name === "service_availability");
    expect(availRule?.query).toBe(original);
    expect(result[0]?.confidence).toBe("unverified");
  });

  it("does not run fallback probing when the agent's pick already works", async () => {
    const execute = vi.fn(async () => promNonEmpty(1));
    scriptedMetricsTool = { execute };

    const svc = buildService("happy-path", 'up{app="happy-path"}', true);
    await runValidateStep({ providers, services: [svc] });

    // Only the original query was probed — no fallback candidates were tried.
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

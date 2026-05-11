import { describe, expect, it } from "vitest";
import { discoverStepTestHooks } from "./index.js";

function promRows(metrics: Array<Record<string, string>>): string {
  return JSON.stringify({
    data: metrics.map((metric) => ({ metric, value: [1778317000, "1"] })),
  });
}

describe("discover deterministic candidate backfill", () => {
  it("extracts workload and catalog candidates from observed Prometheus rows", () => {
    const deployment = discoverStepTestHooks.extractDiscoveryCandidates(
      { expr: "count by (namespace, deployment) (kube_deployment_status_replicas)" },
      promRows([{ namespace: "checkout", deployment: "checkout-api" }]),
      [],
    );
    const catalog = discoverStepTestHooks.extractDiscoveryCandidates(
      { expr: "count by (service_name) (consul_health_service_status)" },
      promRows([{ service_name: "warehouse" }]),
      [],
    );

    expect(deployment).toEqual([
      expect.objectContaining({
        name: "checkout-api",
        source: "deployment",
        metricQuery: 'kube_deployment_status_replicas_available{deployment="checkout-api",namespace="checkout"}',
        logLabels: { namespace: "checkout", container_name: "checkout-api" },
      }),
    ]);
    expect(catalog).toEqual([
      expect.objectContaining({
        name: "warehouse",
        source: "consul",
        metricQuery: 'consul_health_service_status{service_name="warehouse"}',
        logLabels: {},
      }),
    ]);
  });

  it("merges missing observed candidates and enforces exact excludes", () => {
    const candidates = new Map<string, ReturnType<typeof discoverStepTestHooks.extractDiscoveryCandidates>[number]>();
    for (const candidate of discoverStepTestHooks.extractDiscoveryCandidates(
      { expr: "count by (namespace, deployment) (kube_deployment_status_replicas)" },
      promRows([
        { namespace: "checkout", deployment: "checkout-api" },
        { namespace: "monitoring", deployment: "grafana" },
      ]),
      ["grafana"],
    )) {
      candidates.set(candidate.name, candidate);
    }

    const merged = discoverStepTestHooks.mergeCandidatesIntoDiscoveryResult(
      {
        services: [{
          name: "payments-api",
          metrics: [{ query: 'up{job="payments-api"}', description: "up" }],
          logLabels: {},
          probeRules: [],
        }],
        globalProbeRules: [],
      },
      candidates,
      ["grafana"],
    );

    expect(merged.services.map((service) => service.name).sort()).toEqual([
      "checkout-api",
      "payments-api",
    ]);
    expect(merged.services.find((service) => service.name === "checkout-api")?.probeRules.map((rule) => rule.name)).toEqual([
      "service_availability",
      "pod_restarts",
      "log_errors",
    ]);
  });

  it("omits pod_restarts from statefulset/daemonset candidates (no statefulset/daemonset label on the restart counter)", () => {
    const stsCandidates = new Map<string, ReturnType<typeof discoverStepTestHooks.extractDiscoveryCandidates>[number]>();
    for (const candidate of discoverStepTestHooks.extractDiscoveryCandidates(
      { expr: "count by (namespace, statefulset) (kube_statefulset_status_replicas_ready)" },
      promRows([{ namespace: "data", statefulset: "single-sts" }]),
      [],
    )) {
      stsCandidates.set(candidate.name, candidate);
    }
    const dsCandidates = new Map<string, ReturnType<typeof discoverStepTestHooks.extractDiscoveryCandidates>[number]>();
    for (const candidate of discoverStepTestHooks.extractDiscoveryCandidates(
      { expr: "count by (namespace, daemonset) (kube_daemonset_status_number_ready)" },
      promRows([{ namespace: "kube-system", daemonset: "telemetry-collector" }]),
      [],
    )) {
      dsCandidates.set(candidate.name, candidate);
    }

    const stsMerged = discoverStepTestHooks.mergeCandidatesIntoDiscoveryResult(
      { services: [], globalProbeRules: [] },
      stsCandidates,
      [],
    );
    const dsMerged = discoverStepTestHooks.mergeCandidatesIntoDiscoveryResult(
      { services: [], globalProbeRules: [] },
      dsCandidates,
      [],
    );

    expect(stsMerged.services.find((s) => s.name === "single-sts")?.probeRules.map((r) => r.name)).toEqual([
      "service_availability",
      "log_errors",
    ]);
    expect(dsMerged.services.find((s) => s.name === "telemetry-collector")?.probeRules.map((r) => r.name)).toEqual([
      "service_availability",
      "log_errors",
    ]);
  });

  it("drops shard-suffixed StatefulSets regardless of count", () => {
    const candidates = new Map<string, ReturnType<typeof discoverStepTestHooks.extractDiscoveryCandidates>[number]>();
    const rows = Array.from({ length: 12 }, (_, i) => ({ namespace: "db", statefulset: `db-shard${i}` }));
    for (const candidate of discoverStepTestHooks.extractDiscoveryCandidates(
      { expr: "count by (namespace, statefulset) (kube_statefulset_status_replicas_ready)" },
      promRows(rows),
      [],
    )) {
      candidates.set(candidate.name, candidate);
    }

    const merged = discoverStepTestHooks.mergeCandidatesIntoDiscoveryResult(
      { services: [], globalProbeRules: [] },
      candidates,
      [],
    );

    // Shards filtered by the `-shard\d+$` regex in isLowSignalInfrastructureService,
    // not by the (now-removed) blanket source-count skip.
    expect(merged.services).toEqual([]);
  });

  it("admits non-shard StatefulSets even with 12+ of them", () => {
    const names = ["kafka", "zookeeper", "redis-ha-server", "prometheus-server",
                   "stolon-keeper", "clickhouse", "mongodb", "elasticsearch",
                   "neo4j", "cassandra", "minio", "etcd-cluster"];
    const candidates = new Map<string, ReturnType<typeof discoverStepTestHooks.extractDiscoveryCandidates>[number]>();
    const rows = names.map((name) => ({ namespace: "infra", statefulset: name }));
    for (const candidate of discoverStepTestHooks.extractDiscoveryCandidates(
      { expr: "count by (namespace, statefulset) (kube_statefulset_status_replicas_ready)" },
      promRows(rows),
      [],
    )) {
      candidates.set(candidate.name, candidate);
    }

    const merged = discoverStepTestHooks.mergeCandidatesIntoDiscoveryResult(
      { services: [], globalProbeRules: [] },
      candidates,
      [],
    );

    expect(merged.services.map((s) => s.name).sort()).toEqual([...names].sort());
  });

  it("admits openebs-jiva-csi-controller (only openebs-ndm is filtered as a node agent)", () => {
    const candidates = new Map<string, ReturnType<typeof discoverStepTestHooks.extractDiscoveryCandidates>[number]>();
    for (const candidate of discoverStepTestHooks.extractDiscoveryCandidates(
      { expr: "count by (namespace, daemonset) (kube_daemonset_status_desired_number_scheduled)" },
      promRows([
        { namespace: "openebs", daemonset: "openebs-jiva-csi-controller" },
        { namespace: "openebs", daemonset: "openebs-ndm" },
      ]),
      [],
    )) {
      candidates.set(candidate.name, candidate);
    }

    const merged = discoverStepTestHooks.mergeCandidatesIntoDiscoveryResult(
      { services: [], globalProbeRules: [] },
      candidates,
      [],
    );

    expect(merged.services.map((s) => s.name)).toEqual(["openebs-jiva-csi-controller"]);
  });

  it("drops low-signal node agents and StatefulSet shards from LLM output", () => {
    const merged = discoverStepTestHooks.mergeCandidatesIntoDiscoveryResult(
      {
        services: [
          {
            name: "checkout-api",
            metrics: [{ query: 'kube_deployment_status_replicas_available{deployment="checkout-api"}', description: "ready" }],
            logLabels: {},
            probeRules: [],
          },
          {
            name: "kube-proxy",
            metrics: [{ query: 'kube_daemonset_status_number_ready{daemonset="kube-proxy"}', description: "ready" }],
            logLabels: {},
            probeRules: [],
          },
          {
            name: "ch-clickhouse-shard4",
            metrics: [{ query: 'kube_statefulset_status_replicas_ready{statefulset="ch-clickhouse-shard4"}', description: "ready" }],
            logLabels: {},
            probeRules: [],
          },
        ],
        globalProbeRules: [],
      },
      new Map(),
      [],
    );

    expect(merged.services.map((service) => service.name)).toEqual(["checkout-api"]);
  });
});

/**
 * Deterministic discovery candidate extraction + merge.
 *
 * Tool wrapper captures raw Prometheus query results during the agent's
 * tool-calling phase. This module parses those results into typed
 * `DiscoveryCandidate` records (Deployment / StatefulSet / DaemonSet / Consul
 * service), then merges them into the LLM's structured output as a safety
 * net: if the agent hallucinates an empty list, returns a wrong shape, or
 * exits before synthesizing JSON, the deterministic candidates still surface.
 *
 * This subsystem is the load-bearing recall floor — PR #205's kill-test
 * removed an over-aggressive filter here that was hiding 7 services per run.
 */

import type { ServiceConfig, ProbeMetricRule } from "../../../config/schema.js";
import { createLogger } from "../../../logger.js";
import { isExcludedService, isLowSignalInfrastructureService, normalizeServiceName } from "./filters.js";

const logger = createLogger("discover");

export interface DiscoveryCandidate {
  name: string;
  source: "deployment" | "statefulset" | "daemonset" | "consul";
  namespace?: string;
  metricQuery: string;
  metricDescription: string;
  logLabels: Record<string, string>;
  restartQuery?: string;
}

export interface DiscoverStepResult {
  services: ServiceConfig[];
  globalProbeRules: ProbeMetricRule[];
}

const CANDIDATE_SOURCE_PRIORITY: Record<DiscoveryCandidate["source"], number> = {
  deployment: 4,
  statefulset: 3,
  daemonset: 3,
  consul: 2,
};

function promLabelEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function selector(labels: Record<string, string | undefined>): string {
  const parts = Object.entries(labels)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}="${promLabelEscape(value)}"`);
  return `{${parts.join(",")}}`;
}

function logSelector(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${promLabelEscape(value)}"`)
    .join(",");
}

function candidateKey(name: string): string {
  return normalizeServiceName(name);
}

function candidateProbeRules(candidate: DiscoveryCandidate): ProbeMetricRule[] {
  const rules: ProbeMetricRule[] = [{
    name: "service_availability",
    query: candidate.metricQuery,
    threshold: { op: "lt", value: 1 },
    consecutiveTicks: 3,
    source: "metrics",
  }];

  if (candidate.restartQuery) {
    rules.push({
      name: "pod_restarts",
      query: candidate.restartQuery,
      threshold: { op: "gt", value: 0.033 },
      consecutiveTicks: 2,
      source: "metrics",
    });
  }

  if (Object.keys(candidate.logLabels).length > 0) {
    rules.push({
      name: "log_errors",
      query: `sum(count_over_time({${logSelector(candidate.logLabels)}} |= \`error\` or \`fatal\` [15m]))`,
      threshold: { op: "gt", value: 75 },
      consecutiveTicks: 2,
      source: "logs",
    });
  }

  return rules;
}

function serviceFromCandidate(candidate: DiscoveryCandidate): ServiceConfig {
  return {
    name: candidate.name,
    metrics: [{ query: candidate.metricQuery, description: candidate.metricDescription }],
    logLabels: candidate.logLabels,
    probeRules: candidateProbeRules(candidate),
  };
}

export function addCandidate(
  candidates: Map<string, DiscoveryCandidate>,
  candidate: DiscoveryCandidate,
  excludeServices: string[] | undefined,
): void {
  if (!candidate.name || isExcludedService(candidate.name, excludeServices)) return;
  const key = candidateKey(candidate.name);
  const existing = candidates.get(key);
  if (!existing || CANDIDATE_SOURCE_PRIORITY[candidate.source] > CANDIDATE_SOURCE_PRIORITY[existing.source]) {
    candidates.set(key, candidate);
  }
}

function parsePrometheusMetricRows(resultText: string): Array<Record<string, string>> {
  try {
    const parsed = JSON.parse(resultText) as unknown;
    const rows =
      Array.isArray((parsed as { data?: unknown })?.data)
        ? (parsed as { data: unknown[] }).data
        : Array.isArray((parsed as { data?: { result?: unknown[] } })?.data?.result)
          ? (parsed as { data: { result: unknown[] } }).data.result
          : Array.isArray((parsed as { result?: unknown[] })?.result)
            ? (parsed as { result: unknown[] }).result
            : [];
    return rows
      .map((row) => (row && typeof row === "object" ? (row as { metric?: unknown }).metric : undefined))
      .filter((metric): metric is Record<string, string> => {
        if (!metric || typeof metric !== "object") return false;
        return Object.values(metric).every((value) => typeof value === "string");
      });
  } catch {
    return [];
  }
}

export function extractDiscoveryCandidates(
  args: Record<string, unknown>,
  resultText: string,
  excludeServices: string[] | undefined,
): DiscoveryCandidate[] {
  const expr = String(args["expr"] ?? args["query"] ?? "");
  if (!expr) return [];
  const metrics = parsePrometheusMetricRows(resultText);
  const out: DiscoveryCandidate[] = [];

  for (const metric of metrics) {
    const namespace = metric["namespace"];
    if (metric["deployment"]) {
      const name = metric["deployment"];
      out.push({
        name,
        source: "deployment",
        namespace,
        metricQuery: `kube_deployment_status_replicas_available${selector({ deployment: name, namespace })}`,
        metricDescription: "Deployment available replicas",
        logLabels: namespace ? { namespace, container_name: name } : { container_name: name },
        restartQuery: `rate(kube_pod_container_status_restarts_total${selector({ deployment: name })}[5m])`,
      });
    } else if (metric["statefulset"]) {
      const name = metric["statefulset"];
      // No restartQuery: kube_pod_container_status_restarts_total has no
      // statefulset label by default (kube-state-metrics labels are
      // namespace/pod/container/uid/node), so the rule would always read 0.
      // Leave it to LLM-driven discovery to emit a per-cluster correct query.
      out.push({
        name,
        source: "statefulset",
        namespace,
        metricQuery: `kube_statefulset_status_replicas_ready${selector({ statefulset: name, namespace })}`,
        metricDescription: "StatefulSet ready replicas",
        logLabels: namespace ? { namespace, container_name: name } : { container_name: name },
      });
    } else if (metric["daemonset"]) {
      const name = metric["daemonset"];
      // No restartQuery: see statefulset note above. Same label-shape problem.
      out.push({
        name,
        source: "daemonset",
        namespace,
        metricQuery: `kube_daemonset_status_number_ready${selector({ daemonset: name, namespace })}`,
        metricDescription: "DaemonSet ready pods",
        logLabels: namespace ? { namespace, container_name: name } : { container_name: name },
      });
    } else if (expr.includes("consul_health_service_status") && metric["service_name"]) {
      const name = metric["service_name"];
      out.push({
        name,
        source: "consul",
        metricQuery: `consul_health_service_status${selector({ service_name: name })}`,
        metricDescription: "Consul health status",
        logLabels: {},
      });
    }
  }

  return out.filter((candidate) => !isExcludedService(candidate.name, excludeServices));
}

export function mergeCandidatesIntoDiscoveryResult(
  result: DiscoverStepResult,
  candidates: Map<string, DiscoveryCandidate>,
  excludeServices: string[] | undefined,
): DiscoverStepResult {
  const droppedFromLlm = result.services.filter((service) => isLowSignalInfrastructureService(service));
  const services = result.services.filter((service) =>
    !isExcludedService(service.name, excludeServices) &&
    !isLowSignalInfrastructureService(service)
  );
  const existing = new Set(services.map((service) => candidateKey(service.name)));
  const added: ServiceConfig[] = [];
  // Anti-shard guard lives in isLowSignalInfrastructureService (the `-shard\d+$` regex).
  // No blanket source-count skip; that dropped non-shard StatefulSets on busy clusters.
  for (const candidate of [...candidates.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = candidateKey(candidate.name);
    if (existing.has(key)) continue;
    const service = serviceFromCandidate(candidate);
    if (isLowSignalInfrastructureService(service)) continue;
    existing.add(key);
    added.push(service);
  }

  if (droppedFromLlm.length > 0) {
    logger.warn(
      {
        droppedServiceCount: droppedFromLlm.length,
        examples: droppedFromLlm.slice(0, 10).map((service) => service.name),
      },
      "discovery: dropped low-signal infrastructure services from LLM output",
    );
  }

  if (added.length > 0) {
    logger.warn(
      {
        llmServiceCount: result.services.length,
        addedServiceCount: added.length,
        candidateServiceCount: candidates.size,
      },
      "discovery: added services deterministically from observed metric/catalog rows",
    );
  }

  return {
    services: [...services, ...added],
    globalProbeRules: result.globalProbeRules,
  };
}

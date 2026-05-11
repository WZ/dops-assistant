/**
 * Service-name normalization + low-signal filtering for the discover step.
 *
 * These predicates decide which services flow through to `services.yaml`:
 *   - `isExcludedService` honors the operator's `excludeServices` config
 *   - `isLowSignalInfrastructureService` drops shard sweeps and node agents
 *     (DaemonSets per-node, sharded StatefulSets) that would otherwise flood
 *     the registry without meaningful per-instance signal
 *
 * These functions are the load-bearing recall filter — touched by PR #205's
 * kill-test fix that recovered 7 systematically-missed services. Future
 * recall regressions should look here first.
 */

import type { ServiceConfig } from "../../../config/schema.js";

/** Trim + lowercase so user-supplied excludes match regardless of casing or whitespace. */
export function normalizeServiceName(name: string): string {
  return name.trim().toLowerCase();
}

export function isExcludedService(name: string, excludeServices: string[] | undefined): boolean {
  const normalized = normalizeServiceName(name);
  return (excludeServices ?? []).some((excluded) => normalizeServiceName(excluded) === normalized);
}

function serviceQueries(service: ServiceConfig): string {
  return (service.metrics ?? []).map((metric) => metric.query).join("\n").toLowerCase();
}

export function isDaemonSetBackedService(service: ServiceConfig): boolean {
  const queries = serviceQueries(service);
  return queries.includes("kube_daemonset_") || queries.includes("daemonset=");
}

export function isStatefulSetBackedService(service: ServiceConfig): boolean {
  const queries = serviceQueries(service);
  return queries.includes("kube_statefulset_") || queries.includes("statefulset=");
}

export function isLowSignalInfrastructureService(service: ServiceConfig): boolean {
  const name = normalizeServiceName(service.name);
  if (isStatefulSetBackedService(service) && /-shard\d+$/.test(name)) return true;
  if (!isDaemonSetBackedService(service)) return false;
  return (
    /^kube-(proxy|flannel(?:-ds-.+)?)$/.test(name) ||
    name === "openebs-ndm" ||  // node disk manager; controllers/operators are workloads
    name === "promtail" ||
    name === "prometheus-node-exporter" ||
    name === "process-exporter" ||
    name === "speaker" ||
    name.endsWith("-node-agent")
  );
}

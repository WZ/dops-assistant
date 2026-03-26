/**
 * Infer service dependency graph from service registry data.
 * Uses metric query labels and service name patterns to detect relationships.
 *
 * Shared between service-brief.ts (Overview tab) and routes.ts (Dependencies tab).
 */

import type { ServiceConfig } from "../config/schema.js";
import type { BriefDependencyNode, BriefDependencyEdge } from "../types/service-brief.js";

export function inferDependencyGraph(
  services: ServiceConfig[],
): { nodes: BriefDependencyNode[]; edges: BriefDependencyEdge[] } {
  const nodes: BriefDependencyNode[] = services.map(s => ({
    id: s.name,
    name: s.name,
    type: "service" as const,
    status: "unknown" as const,
  }));

  const edges: BriefDependencyEdge[] = [];
  const serviceNames = new Set(services.map(s => s.name));

  for (const svc of services) {
    // Check if any metric queries reference other services by name
    for (const metric of svc.metrics) {
      for (const otherName of serviceNames) {
        if (otherName === svc.name) continue;
        if (metric.query.includes(otherName) || metric.query.includes(otherName.replace(/-/g, "_"))) {
          if (!edges.some(e => e.source === svc.name && e.target === otherName)) {
            edges.push({ source: svc.name, target: otherName, label: "metrics" });
          }
        }
      }
    }

    // Check log labels for service references
    const logLabelValues = Object.values(svc.logLabels ?? {});
    for (const val of logLabelValues) {
      for (const otherName of serviceNames) {
        if (otherName === svc.name) continue;
        if (val.includes(otherName)) {
          if (!edges.some(e => e.source === svc.name && e.target === otherName)) {
            edges.push({ source: svc.name, target: otherName, label: "logs" });
          }
        }
      }
    }
  }

  return { nodes, edges };
}

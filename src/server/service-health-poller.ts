/**
 * ServiceHealthPoller — background service that polls Prometheus every 60s
 * via MCP `query_prometheus` tool and tracks health status per service.
 *
 * Health states:
 *   "healthy"  — service found with replicas/targets up
 *   "degraded" — partial results (some replicas/targets up but not all)
 *   "down"     — service found but no replicas/targets up
 *   "unknown"  — service not found in any Prometheus query result
 *
 * Follows the health-monitor.ts pattern: timer + cached results + start/stop.
 */

import pino from "pino";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { Database } from "./db.js";
import { getAllTools } from "../mcp/provider.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export type HealthStatus = "healthy" | "degraded" | "down" | "unknown";

export interface HealthCheckRow {
  status: string;
  checked_at: string;
}

export interface HealthSummary {
  healthy: number;
  degraded: number;
  down: number;
  unknown: number;
  total: number;
}

export interface ServiceHealthPollerDeps {
  /** Provider list or getter function for live provider resolution */
  providers: MastraProvider[] | (() => MastraProvider[]);
  registryStore: ServiceRegistryStore;
  db: Database;
  intervalMs?: number;
  onTransition?: (service: string, from: HealthStatus, to: HealthStatus) => void;
}

/** Prometheus query_prometheus result entry */
interface PrometheusResultEntry {
  metric: Record<string, string>;
  value?: [number, string];
  values?: [number, string][];
}

/** The data shape returned by query_prometheus */
interface PrometheusQueryResult {
  data?: {
    result?: PrometheusResultEntry[];
  };
  result?: PrometheusResultEntry[];
}

/**
 * Parse MCP tool call result — tool responses may be wrapped in MCP content format
 * or returned directly as JSON.
 */
export function parsePrometheusResult(raw: unknown): PrometheusResultEntry[] {
  if (!raw) return [];

  // MCP content-wrapped format: { content: [{ type: "text", text: "..." }] }
  let parsed: unknown = raw;
  if (typeof raw === "object" && raw !== null && "content" in raw) {
    const content = (raw as { content: unknown[] }).content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as { type?: string; text?: string };
      if (first.type === "text" && typeof first.text === "string") {
        try {
          parsed = JSON.parse(first.text);
        } catch {
          return [];
        }
      }
    }
  }

  // Direct string result
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }

  const obj = parsed as PrometheusQueryResult;

  // Unwrap data.result (standard Prometheus API)
  if (obj?.data?.result && Array.isArray(obj.data.result)) {
    return obj.data.result;
  }

  // Unwrap data as direct array (Grafana MCP format)
  if (obj?.data && Array.isArray(obj.data)) {
    return obj.data;
  }

  // Flat result array
  if (obj?.result && Array.isArray(obj.result)) {
    return obj.result;
  }

  // Direct array
  if (Array.isArray(parsed)) {
    return parsed as PrometheusResultEntry[];
  }

  return [];
}

/**
 * Given Prometheus result entries and a set of service names, determine health status.
 *
 * Label precedence for name matching (in order):
 *   deployment → statefulset → job → instance → service
 *
 * Returns a map of { serviceName → status } for any matched services.
 */
export function matchResultsToServices(
  entries: PrometheusResultEntry[],
  serviceNames: Set<string>,
): Map<string, HealthStatus> {
  const result = new Map<string, HealthStatus>();

  for (const entry of entries) {
    const metric = entry.metric ?? {};
    // Candidate labels to match against service names (priority order)
    const candidates = [
      metric["deployment"],
      metric["statefulset"],
      metric["job"],
      metric["instance"],
      metric["service"],
    ].filter((v): v is string => Boolean(v));

    for (const candidate of candidates) {
      // Exact match or prefix match (e.g. "my-service-abc123" → "my-service")
      const matchedName = [...serviceNames].find(
        (name) =>
          candidate === name ||
          candidate.startsWith(name + "-") ||
          candidate.startsWith(name + "_"),
      );

      if (matchedName) {
        // Get the scalar value — for instant vectors it's entry.value[1]
        const valStr = entry.value?.[1];
        const val = valStr !== undefined ? parseFloat(valStr) : NaN;
        const isUp = !isNaN(val) && val > 0;

        // If already marked healthy, keep it; don't downgrade
        if (result.get(matchedName) === "healthy") break;
        result.set(matchedName, isUp ? "healthy" : "down");
        break;
      }
    }
  }

  return result;
}

export class ServiceHealthPoller {
  private readonly resolveProviders: () => MastraProvider[];
  private readonly registryStore: ServiceRegistryStore;
  private readonly db: Database;
  private readonly intervalMs: number;
  private readonly onTransition?: (service: string, from: HealthStatus, to: HealthStatus) => void;

  private cachedHealth: Map<string, HealthStatus> = new Map();
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  private migrated = false;

  constructor(deps: ServiceHealthPollerDeps) {
    this.resolveProviders = typeof deps.providers === "function"
      ? deps.providers
      : () => deps.providers as MastraProvider[];
    this.registryStore = deps.registryStore;
    this.db = deps.db;
    this.intervalMs = deps.intervalMs ?? 60_000;
    this.onTransition = deps.onTransition;
  }

  /** Start the poller — runs immediately, then on interval. */
  start(): void {
    this.ensureMigrated();
    this.poll().catch((err) => logger.warn({ err }, "ServiceHealthPoller: initial poll failed"));
    this.intervalHandle = setInterval(() => {
      this.poll().catch((err) => logger.warn({ err }, "ServiceHealthPoller: poll failed"));
    }, this.intervalMs);
  }

  /** Stop the poller. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  /** Run a single poll cycle — batch queries, match, detect transitions, persist. */
  async poll(): Promise<void> {
    try {
      const services = this.registryStore.load();
      if (services.length === 0) {
        logger.debug("ServiceHealthPoller: no services registered, skipping poll");
        return;
      }

      const serviceNames = new Set(services.map((s) => s.name));

      // Find query_prometheus tool
      let tools: Record<string, unknown>;
      try {
        tools = await getAllTools(this.resolveProviders()) as Record<string, unknown>;
      } catch (err) {
        logger.warn({ err }, "ServiceHealthPoller: failed to get MCP tools, skipping poll");
        return;
      }

      const queryTool = this.findQueryPrometheusTool(tools);
      if (!queryTool) {
        logger.warn("ServiceHealthPoller: query_prometheus tool not found, skipping poll");
        return;
      }

      // Find the Prometheus datasource UID (required by grafana-mcp)
      const promDsUid = await this.findPrometheusDatasourceUid(tools);

      // Run the 3 batch queries in parallel — query raw metrics (not > 0 / == 1)
      // so that zero-replica or down services appear in results with value 0.
      // matchResultsToServices handles value-based health classification.
      const [deploymentEntries, statefulsetEntries, upEntries] = await Promise.all([
        this.runQuery(queryTool, "kube_deployment_status_replicas", promDsUid),
        this.runQuery(queryTool, "kube_statefulset_status_replicas", promDsUid),
        this.runQuery(queryTool, "up", promDsUid),
      ]);

      // Merge all result entries
      const allEntries = [...deploymentEntries, ...statefulsetEntries, ...upEntries];

      // Match entries to known services
      const newHealth = matchResultsToServices(allEntries, serviceNames);

      // Services with no match → "unknown"
      for (const name of serviceNames) {
        if (!newHealth.has(name)) {
          newHealth.set(name, "unknown");
        }
      }

      const checkedAt = new Date().toISOString();

      // Detect transitions and persist
      for (const [service, status] of newHealth) {
        const previous = this.cachedHealth.get(service);
        if (previous !== undefined && previous !== status && this.onTransition) {
          try {
            this.onTransition(service, previous, status);
          } catch (err) {
            logger.warn({ err, service }, "ServiceHealthPoller: onTransition callback threw");
          }
        }
        this.persistHealthCheck(service, status, checkedAt);
      }

      // Update cache
      this.cachedHealth = newHealth;

      logger.info(
        { summary: this.getSummary() },
        "ServiceHealthPoller: poll complete",
      );
    } catch (err) {
      logger.warn({ err }, "ServiceHealthPoller: poll cycle error — degrading gracefully");
      // Do not update cache — keep last known status
    }
  }

  /** Return the cached health map (copy). */
  getHealth(): Map<string, HealthStatus> {
    return new Map(this.cachedHealth);
  }

  /**
   * Return health check history for a service over the last N hours.
   * Returns records in ascending chronological order.
   */
  getHistory(service: string, hours: number): HealthCheckRow[] {
    try {
      return this.db.getServiceHealthHistory(service, hours);
    } catch {
      return [];
    }
  }

  /** Return a summary of health counts across all known services. */
  getSummary(): HealthSummary {
    let healthy = 0, degraded = 0, down = 0, unknown = 0;
    for (const status of this.cachedHealth.values()) {
      if (status === "healthy") healthy++;
      else if (status === "degraded") degraded++;
      else if (status === "down") down++;
      else unknown++;
    }
    return { healthy, degraded, down, unknown, total: this.cachedHealth.size };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async findPrometheusDatasourceUid(
    tools: Record<string, unknown>,
  ): Promise<string | undefined> {
    const listDsTool = Object.entries(tools).find(([name]) => name.endsWith("list_datasources"));
    if (!listDsTool) return undefined;
    try {
      const result = await (listDsTool[1] as { execute: (args: unknown) => Promise<unknown> }).execute({});
      const outer = typeof result === "string" ? JSON.parse(result) : result;
      const data = outer?.content?.[0]?.text ? JSON.parse(outer.content[0].text) : outer;
      const datasources = Array.isArray(data) ? data : data?.datasources ?? [];
      const prom = datasources.find((ds: Record<string, unknown>) =>
        ds.type === "prometheus" || (ds.typeName as string)?.toLowerCase().includes("prometheus") || (ds.name as string)?.toLowerCase().includes("prometheus")
      );
      if (prom?.uid) {
        logger.info({ uid: prom.uid, name: prom.name }, "ServiceHealthPoller: found Prometheus datasource");
        return prom.uid as string;
      }
    } catch (err) {
      logger.warn({ err }, "ServiceHealthPoller: failed to find Prometheus datasource UID");
    }
    return undefined;
  }

  private findQueryPrometheusTool(
    tools: Record<string, unknown>,
  ): { execute: (args: unknown) => Promise<unknown> } | null {
    for (const [name, tool] of Object.entries(tools)) {
      if (name === "query_prometheus" || name.endsWith("_query_prometheus")) {
        return tool as { execute: (args: unknown) => Promise<unknown> };
      }
    }
    return null;
  }

  private async runQuery(
    tool: { execute: (args: unknown) => Promise<unknown> },
    query: string,
    datasourceUid?: string,
  ): Promise<PrometheusResultEntry[]> {
    try {
      const now = new Date();
      const startTime = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago
      const endTime = now.toISOString();
      const args: Record<string, unknown> = { expr: query, queryType: "instant", startTime, endTime };
      if (datasourceUid) args.datasourceUid = datasourceUid;
      const result = await tool.execute(args);
      const entries = parsePrometheusResult(result);
      if (entries.length === 0) {
        logger.info({ query, rawPreview: JSON.stringify(result).slice(0, 500) }, "ServiceHealthPoller: empty query result");
      } else {
        logger.info({ query, entriesCount: entries.length }, "ServiceHealthPoller: query result");
      }
      return entries;
    } catch (err) {
      logger.warn({ err, query }, "ServiceHealthPoller: query failed, treating as empty");
      return [];
    }
  }

  private persistHealthCheck(service: string, status: HealthStatus, checkedAt: string): void {
    try {
      this.db.insertServiceHealthCheck(service, status, checkedAt);
    } catch (err) {
      logger.warn({ err, service }, "ServiceHealthPoller: failed to persist health check");
    }
  }

  private ensureMigrated(): void {
    if (this.migrated) return;
    try {
      this.db.migrateServiceHealthChecks();
      this.migrated = true;
    } catch (err) {
      logger.warn({ err }, "ServiceHealthPoller: DB migration failed");
    }
  }
}

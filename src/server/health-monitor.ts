/**
 * Background health monitor — probes MCP, LLM, and DB connectivity on a
 * 30-second interval. The GET /api/health endpoint reads cached status (instant).
 *
 * Probe results:
 *   "healthy"  — all probes pass
 *   "degraded" — one or more probes fail but the server is running
 *   "unhealthy"— critical failure
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { createLogger } from "../logger.js";
import type { MastraProvider } from "../mcp/provider.js";
import type { ProviderInfo } from "../mcp/provider-registry.js";
import type { Database } from "./db.js";
import { eventLog } from "./event-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "../../package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

const logger = createLogger();

export interface ProbeResult {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  version: string;
  probes: {
    mcp: ProbeResult;
    db: ProbeResult;
  };
  lastCheck: string;
}

const startTime = Date.now();
let cachedStatus: HealthStatus = {
  status: "healthy",
  uptime: 0,
  version: VERSION,
  probes: {
    mcp: { status: "ok", latencyMs: 0 },
    db: { status: "ok", latencyMs: 0 },
  },
  lastCheck: new Date().toISOString(),
};

/**
 * Derive an MCP probe result from registry state. Preferred over
 * `probeMcpLegacy` because @mastra/mcp's MCPClient.listTools() catches
 * per-server connection failures and silently returns {} — meaning a
 * direct listTools() call always says "ok" even when every upstream is
 * dead. The registry already reconciles this (see provider-registry's
 * "0 tools = error" heuristic), so reading its status is authoritative.
 */
function probeMcpFromRegistry(infos: ProviderInfo[]): ProbeResult {
  if (infos.length === 0) return { status: "ok", latencyMs: 0 };

  const errored = infos.filter((p) => p.status === "error");
  const usable = infos.filter((p) => p.status === "connected" && p.toolCount > 0);

  if (errored.length === 0 && usable.length > 0) {
    return { status: "ok", latencyMs: 0 };
  }

  const total = infos.length;
  const summary = errored.length === total
    ? `all ${total} MCP provider${total !== 1 ? "s" : ""} unreachable`
    : `${errored.length} of ${total} MCP providers unreachable`;
  // Keep the count-based summary first; individual registry errors are often
  // generic ("MCP server returned no tools") and otherwise hide the outage size.
  const providerError = errored.find((p) => p.error)?.error;
  const error = providerError ? `${summary}: ${providerError}` : summary;
  return { status: "error", latencyMs: 0, error };
}

async function probeMcpLegacy(providers: MastraProvider[]): Promise<ProbeResult> {
  if (providers.length === 0) return { status: "ok", latencyMs: 0 };
  const start = Date.now();
  try {
    // Try to list tools from the first provider — proves MCP connectivity
    await providers[0]!.client.listTools();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: "error", latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

function probeDb(db: Database): ProbeResult {
  const start = Date.now();
  try {
    // Run a trivial query to prove DB is accessible — pass empty stackId for health probe
    db.listInvestigations("", { limit: 1 });
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: "error", latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface HealthMonitorDeps {
  providers: MastraProvider[] | (() => MastraProvider[]);
  db: Database;
}

/** Alternative deps that accept a StackManager for multi-stack support */
export interface HealthMonitorStackDeps {
  stackManager: {
    getDefaultContext(): {
      providerRegistry: {
        getAll(): ProviderInfo[];
      };
    };
  };
  db: Database;
}

let intervalHandle: ReturnType<typeof setInterval> | undefined;
// Track previous probe statuses for transition detection (one entry per named probe)
const prevProbeStatus: Record<string, "ok" | "error"> = {};

export function startHealthMonitor(deps: HealthMonitorDeps | HealthMonitorStackDeps, intervalMs = 30_000): void {
  // Two probe sources: the production path reads registry status (which
  // already accounts for "0 tools = unreachable" after PR #183), while the
  // legacy MastraProvider[] path is kept for callers that don't have a
  // registry handy (notably tests pre-dating the registry-backed setup).
  let resolveMcpProbe: () => Promise<ProbeResult>;
  if ("stackManager" in deps) {
    resolveMcpProbe = async () =>
      probeMcpFromRegistry(deps.stackManager.getDefaultContext().providerRegistry.getAll());
  } else {
    const resolveProviders: () => MastraProvider[] = typeof deps.providers === "function"
      ? deps.providers
      : () => deps.providers as MastraProvider[];
    resolveMcpProbe = () => probeMcpLegacy(resolveProviders());
  }

  const runProbes = async () => {
    const [mcp, db] = await Promise.all([
      resolveMcpProbe(),
      Promise.resolve(probeDb(deps.db)),
    ]);

    const anyError = mcp.status === "error" || db.status === "error";
    cachedStatus = {
      status: anyError ? "degraded" : "healthy",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: VERSION,
      probes: { mcp, db },
      lastCheck: new Date().toISOString(),
    };

    // Emit events for probe status transitions (only on actual state change)
    for (const [providerName, probeResult] of [["mcp", mcp], ["db", db]] as [string, ProbeResult][]) {
      const prevState = prevProbeStatus[providerName];
      const nextState = probeResult.status;
      if (prevState !== undefined && prevState !== nextState) {
        eventLog.append({
          kind: "provider_health_changed",
          severity: nextState === "error" ? "error" : "success",
          summary: `provider ${providerName}: ${prevState} → ${nextState}`,
          meta: { provider: providerName, from: prevState, to: nextState },
        });
      }
      prevProbeStatus[providerName] = nextState;
    }
  };

  // Run immediately on startup, then on interval
  runProbes().catch((err) => logger.warn({ err }, "Health probe failed"));
  intervalHandle = setInterval(() => {
    runProbes().catch((err) => logger.warn({ err }, "Health probe failed"));
  }, intervalMs);
}

export function stopHealthMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}

export function healthHandler(_req: Request, res: Response): void {
  cachedStatus.uptime = Math.floor((Date.now() - startTime) / 1000);
  const statusCode = cachedStatus.status === "healthy" ? 200 : 503;
  res.status(statusCode).json(cachedStatus);
}

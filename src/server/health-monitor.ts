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
import type { Database } from "./db.js";

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

async function probeMcp(providers: MastraProvider[]): Promise<ProbeResult> {
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
    db.listInvestigations("", 1, 0);
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
  stackManager: { getDefaultContext(): { providerRegistry: { getProviders(): MastraProvider[] } } };
  db: Database;
}

let intervalHandle: ReturnType<typeof setInterval> | undefined;

export function startHealthMonitor(deps: HealthMonitorDeps | HealthMonitorStackDeps, intervalMs = 30_000): void {
  let resolveProviders: () => MastraProvider[];
  if ("stackManager" in deps) {
    resolveProviders = () => deps.stackManager.getDefaultContext().providerRegistry.getProviders();
  } else {
    resolveProviders = typeof deps.providers === "function"
      ? deps.providers
      : () => deps.providers as MastraProvider[];
  }

  const runProbes = async () => {
    const [mcp, db] = await Promise.all([
      probeMcp(resolveProviders()),
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

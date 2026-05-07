/**
 * Background health monitor — probes DB connectivity on a 30-second interval.
 * The GET /api/health endpoint reads the cached status (instant) and always
 * returns 200; component status lives in the JSON body.
 *
 * MCP probing was removed in the health-monitor cleanup — `/api/health` is a
 * server-level liveness signal (k8s readiness/liveness probes hit it), and
 * MCP health is per-stack. The UI reads `activeStack.providerHealth` from
 * `/api/stacks` for that. Letting MCP failures flip the cached status here
 * was load-bearing for nothing useful and previously caused a self-inflicted
 * 503 outage when the registry-aware probe (PR #184) correctly detected
 * unreachable upstreams.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { createLogger } from "../logger.js";
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
    db: { status: "ok", latencyMs: 0 },
  },
  lastCheck: new Date().toISOString(),
};

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
  db: Database;
}

let intervalHandle: ReturnType<typeof setInterval> | undefined;
// Track previous DB status for transition detection (one entry; preserved
// across runs so the first cycle after a restart doesn't emit a spurious event).
let prevDbStatus: "ok" | "error" | undefined;

export function startHealthMonitor(deps: HealthMonitorDeps, intervalMs = 30_000): void {
  const runProbes = async () => {
    const db = probeDb(deps.db);

    cachedStatus = {
      status: db.status === "error" ? "degraded" : "healthy",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: VERSION,
      probes: { db },
      lastCheck: new Date().toISOString(),
    };

    // DB transition events. (Per-stack MCP transitions live in the registry —
    // see ProviderRegistry's onChange listeners.)
    const nextState = db.status;
    if (prevDbStatus !== undefined && prevDbStatus !== nextState) {
      eventLog.append({
        kind: "provider_health_changed",
        severity: nextState === "error" ? "error" : "success",
        summary: `provider db: ${prevDbStatus} → ${nextState}`,
        meta: { provider: "db", from: prevDbStatus, to: nextState },
      });
    }
    prevDbStatus = nextState;
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
  // prevDbStatus deliberately persists across stop/start so a transient
  // restart doesn't emit a spurious "first cycle" transition event.
}

export function healthHandler(_req: Request, res: Response): void {
  cachedStatus.uptime = Math.floor((Date.now() - startTime) / 1000);
  // Always 200 — the server is up and serving the response right now, which
  // is what the k8s readiness/liveness probes ask. Component status is data
  // for the UI strip, not a kill switch.
  res.status(200).json(cachedStatus);
}

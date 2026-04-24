/**
 * Demo mode — read-only showcase for a public demo site.
 *
 * When `DEMO_MODE=true` is set in the environment:
 *   - All mutating HTTP requests (non-GET) are rejected by `demoModeMiddleware`
 *     with a 403 JSON body (except a narrow exception list: health check,
 *     thumbs-up feedback).
 *   - Background jobs that would make LLM calls or hit real infrastructure
 *     (scan scheduler, health poller, investigation runner, chat agent,
 *     webhook handler) early-return at their entry points.
 *   - The SPA receives `window.__DEMO_MODE__ = true` via index.html rewrite,
 *     so the UI can render the "demo mode" banner.
 *
 * DEMO_MODE is an env var (not a config.yaml field) on purpose: a demo
 * deployment flips it at the orchestrator/Helm/Fly level without touching
 * the operator-facing config surface.
 */
import type { NextFunction, Request, Response } from "express";

export function isDemoMode(): boolean {
  const raw = process.env["DEMO_MODE"];
  return raw === "true" || raw === "1";
}

/**
 * Paths (relative to the /api mount) that are allowed to accept non-GET
 * requests even in demo mode. Keep this list tight — every entry is a way
 * for a visitor to write to the system.
 *
 *   /health                            — liveness probe, never touches user data
 *   /investigations/:id/feedback       — thumbs-up on seed investigations. Purely
 *                                        additive, bounded, and the UI element
 *                                        is the whole point of the AP10 feature.
 */
const DEMO_MUTATION_ALLOWLIST: RegExp[] = [
  /^\/health$/,
  /^\/investigations\/[^/]+\/feedback$/,
];

function isMutationAllowed(pathAfterApi: string): boolean {
  return DEMO_MUTATION_ALLOWLIST.some((re) => re.test(pathAfterApi));
}

/**
 * Express middleware that rejects mutating requests with a structured 403
 * when DEMO_MODE is active. Install after the /api rate limiter and before
 * the API key middleware — rejecting early keeps write paths from warming
 * up DB transactions or MCP clients for requests that will never succeed.
 *
 * When DEMO_MODE is off, the middleware is a pass-through — it does not
 * read env on every request (the flag is captured once at factory time).
 */
export function createDemoModeMiddleware() {
  const active = isDemoMode();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!active) return next();
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    // `req.path` here is already relative to the /api mount point.
    if (isMutationAllowed(req.path)) return next();
    res.status(403).json({
      error: "Demo mode — this action is disabled on the public demo.",
      demoMode: true,
      hint: "Clone the repo and run it yourself to investigate, re-run, send notifications, or modify config.",
    });
  };
}

/**
 * API key authentication middleware for mutating (non-GET) routes.
 *
 * When an API key is configured, all POST/PUT/DELETE/PATCH requests must
 * include a matching `X-API-Key` header. GET requests are always allowed
 * (read-only). When no API key is configured, all requests pass through
 * (backward compatible).
 */

import type { Request, Response, NextFunction } from "express";

/**
 * Creates Express middleware that enforces API key auth on mutating requests.
 *
 * @param apiKey - The expected API key. If undefined/empty, middleware is a pass-through.
 * @param exemptPaths - URL paths exempt from auth (e.g., webhook endpoints with their own auth).
 */
export function createApiKeyMiddleware(
  apiKey?: string,
  exemptPaths: string[] = [],
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // No API key configured — pass-through (backward compatible)
    if (!apiKey) {
      next();
      return;
    }

    // GET requests are read-only — always allowed
    if (req.method === "GET") {
      next();
      return;
    }

    // Check exempt paths (e.g., webhook endpoints with their own auth)
    if (exemptPaths.some((p) => req.path.startsWith(p))) {
      next();
      return;
    }

    // Validate X-API-Key header
    const provided = req.headers["x-api-key"] as string | undefined;
    if (!provided || provided !== apiKey) {
      res.status(403).json({
        error: "Forbidden",
        message: "Invalid or missing API key",
      });
      return;
    }

    next();
  };
}

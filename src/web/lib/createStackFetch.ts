import { safeGetItem } from "./utils";
import { staticFetch, isStaticDemoBuild } from "./staticFetch";

declare global {
  interface Window {
    __APP_BASE__?: string;
    /** Server-injected (index.ts) when config.agent.challengeEnabled is true.
     *  Gates the "Deep investigate" button — hidden from users until the
     *  Autonomous Orchestrator ships. */
    __CHALLENGE__?: boolean;
    /** Server-injected (index.ts) when config.agent.autonomousInvestigationEnabled is true.
     *  Gates the "Investigate autonomously" trigger — hidden until validated. */
    __AUTONOMOUS__?: boolean;
  }
}

/** Ensure a base path has leading AND trailing "/". Defensive against
 *  misconfigured operators or future server bugs that produce "/dops" or
 *  "dops/" — without this, withBase("/api/health") silently corrupts URLs. */
function normalizeBase(raw: string): string {
  if (!raw || raw === "/") return "/";
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "/" : `/${trimmed}/`;
}

/**
 * Base path for the app, ending in "/". Resolution order:
 *   1. `window.__APP_BASE__` — injected by the server at render time, driven
 *      by the APP_BASE_PATH env var. This is the runtime-configurable path
 *      and the correct source of truth for deployed installs.
 *   2. `import.meta.env.BASE_URL` — Vite's build-time base. Still honoured so
 *      dev mode (vite's own server) works without extra config.
 *   3. "/" — root fallback.
 */
export const APP_BASE_PATH = normalizeBase(
  (typeof window !== "undefined" && window.__APP_BASE__) ||
    import.meta.env.BASE_URL ||
    "/",
);

/** Prepend the app base path to an API URL (e.g., "/api/health" → "/dops/api/health"). */
export function withBase(url: string): string {
  if (APP_BASE_PATH === "/") return url;
  const stripped = url.startsWith("/") ? url.slice(1) : url;
  return `${APP_BASE_PATH}${stripped}`;
}

export function createStackFetch(activeStackId: string) {
  return (url: string, opts?: RequestInit): Promise<Response> => {
    // Static-demo build: no server exists. Route every API call through
    // staticFetch, which serves pre-generated JSON snapshots from the
    // GitHub Pages bundle and returns a synthetic 403 for mutations.
    if (isStaticDemoBuild()) {
      return staticFetch(url, opts, withBase);
    }
    const headers = new Headers(opts?.headers);
    headers.set("X-Stack-Id", activeStackId);
    const apiKey = safeGetItem("dops-api-key");
    if (apiKey) {
      headers.set("X-API-Key", apiKey);
    }
    return fetch(withBase(url), { ...opts, headers });
  };
}

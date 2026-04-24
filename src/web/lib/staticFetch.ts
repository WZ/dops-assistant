/**
 * Static-demo fetch adapter — used by `createStackFetch` when the SPA
 * is built for a server-less deploy (GitHub Pages).
 *
 * Active when `VITE_DEMO_STATIC=true` at build time. In that mode the SPA
 * has no server to talk to — every `/api/*` path is served as a pre-baked
 * JSON file produced by `scripts/export-static.ts`.
 *
 * Two things happen:
 *   1. GET requests → path rewritten to the corresponding static .json file.
 *      Query parameters are stripped (filters happen client-side) except for
 *      paths whose JSON output fans out by query value.
 *   2. Non-GET requests → synthetic 403 response matching the shape of the
 *      live demo-mode middleware, so the SPA doesn't need a separate
 *      "static demo" branch for error handling.
 *
 * Client-side filter shim: when the SPA asks for `/api/investigations?sev=..`
 * we return the full seeded list and let the `/investigations` page's
 * existing in-memory filter code do the work. There are 5 investigations —
 * filter perf isn't a concern.
 */

/**
 * True when the bundle was built with `VITE_DEMO_STATIC=true`. This is
 * inlined at build time by Vite, so dead code is tree-shaken in non-static
 * builds.
 */
export function isStaticDemoBuild(): boolean {
  // import.meta.env values are replaced at build time, so the string compare
  // is evaluated during bundling; the live-server branch becomes unreachable.
  return import.meta.env.VITE_DEMO_STATIC === "true";
}

const DEMO_403_BODY = JSON.stringify({
  error: "Demo mode — this action is disabled on the public demo.",
  demoMode: true,
  hint: "Clone the repo and run it yourself to investigate, re-run, send notifications, or modify config.",
});

function demo403(): Response {
  return new Response(DEMO_403_BODY, {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Map an API path + query to a static file path.
 *
 *   /api/investigations?severity=high  → /api/investigations.json
 *   /api/investigations/inv_123        → /api/investigations/inv_123.json
 *   /api/scan/runs                     → /api/scan/runs.json
 *   /api/scan/runs/sr_456              → /api/scan/runs/sr_456.json
 *
 * Some endpoints still need per-query snapshots — those are listed here and
 * get their query string hashed into the filename. The exporter writes the
 * matching files. Today only `/api/investigations/severity-counts` fans out
 * by query, but we keep the mechanism generic.
 */
/**
 * Paths where ONE query parameter actually matters for the static snapshot.
 * All other query params (`limit`, `offset`, `sort`, filter params — the
 * client filters those in-memory after fetch) are stripped from the filename.
 *
 * Must match `DISTINGUISHING_PARAM` in `scripts/export-static.ts`.
 */
const DISTINGUISHING_PARAM: Record<string, string> = {
  "/api/patterns": "service",                  // server 400s without ?service=X
  "/api/services/health/history": "service",   // per-service history rows
  "/api/messages": "investigationId",          // per-chat messages
  "/api/investigations": "service",            // ServiceDetail filters by service
};

function toStaticPath(url: string): string {
  // Strip the query (most endpoints) or keep just the distinguishing param
  // (endpoints in DISTINGUISHING_PARAM). All other params drop out.
  const qMark = url.indexOf("?");
  const pathOnly = qMark >= 0 ? url.slice(0, qMark) : url;
  const query = qMark >= 0 ? url.slice(qMark + 1) : "";

  const trimmed = pathOnly.endsWith("/") && pathOnly.length > 1 ? pathOnly.slice(0, -1) : pathOnly;

  const paramName = DISTINGUISHING_PARAM[trimmed];
  if (paramName && query) {
    const params = new URLSearchParams(query);
    const value = params.get(paramName);
    if (value) {
      return `${trimmed}.${paramName}=${encodeURIComponent(value)}.json`;
    }
  }
  return `${trimmed}.json`;
}

export async function staticFetch(
  url: string,
  opts: RequestInit | undefined,
  withBase: (u: string) => string,
): Promise<Response> {
  const method = (opts?.method ?? "GET").toUpperCase();

  // Non-GET always 403s in static mode — matches live demo-mode middleware.
  if (method !== "GET" && method !== "HEAD") {
    return demo403();
  }

  const staticPath = toStaticPath(url);
  const fetchUrl = withBase(staticPath);
  const res = await fetch(fetchUrl);

  // Pages 404s as HTML — if we didn't generate this file, surface a clear
  // error with the attempted path so the operator knows what to add to the
  // exporter's route list.
  if (!res.ok && res.status === 404) {
    return new Response(
      JSON.stringify({
        error: `Static demo: no snapshot for ${url}`,
        demoMode: true,
        hint: `Add ${staticPath} to scripts/export-static.ts and rerun the workflow.`,
        attemptedUrl: fetchUrl,
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  return res;
}

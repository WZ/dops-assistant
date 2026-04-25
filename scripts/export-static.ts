/**
 * Export the seeded demo as a set of static JSON snapshots.
 *
 * Pairs with `scripts/seed-demo.ts` and `src/web/lib/staticFetch.ts`:
 *   1. seed-demo.ts writes the fixture DB
 *   2. this script boots the server briefly + walks every GET endpoint the
 *      SPA might call, saving each response to dist/web/api/...
 *   3. staticFetch.ts (active in `VITE_DEMO_STATIC=true` builds) serves the
 *      SPA's API calls out of those snapshots instead of a live server
 *
 * Result: `dist/web/` is a fully functional read-only demo that runs on
 * GitHub Pages with zero backend. Filters, pagination, severity pills are
 * all client-side against the snapshotted list.
 *
 * Usage (in CI):
 *   npm run build:web               # builds the SPA bundle
 *   npm run seed:demo               # writes data-demo/
 *   npm run export-static           # boots server + writes snapshots
 *
 * The CI workflow (`.github/workflows/deploy-demo.yml`) runs this then
 * uploads `dist/web/` to GitHub Pages.
 *
 * Env:
 *   OUT_DIR   where to write snapshots (default: dist/web/api)
 *   PORT      ephemeral port to boot the server on (default: 31000)
 *   DB_PATH   path to seeded DB (default: data-demo/dops.sqlite)
 *   DATA_DIR  data root (default: data-demo)
 */

import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const OUT_DIR = process.env["OUT_DIR"] ?? "dist/web/api";
const PORT = Number(process.env["PORT"] ?? 31000);
const DB_PATH = process.env["DB_PATH"] ?? "data-demo/dops.sqlite";
const DATA_DIR = process.env["DATA_DIR"] ?? "data-demo";
const BASE = `http://127.0.0.1:${PORT}`;

// ── Endpoint list ───────────────────────────────────────────────────────────
//
// Every path here is written as a static snapshot at dist/web/api/<path>.json.
// When the SPA requests /api/foo, staticFetch rewrites to /api/foo.json.
//
// Keep this list in sync with the SPA's fetch calls. If a page 404s on the
// static demo, it almost certainly means the path it wants isn't covered here.

const STATIC_TOP: string[] = [
  "/api/health",
  "/api/investigations",              // unfiltered, for /investigations page
  "/api/investigations?limit=25",     // Dashboard top-N snippet
  "/api/investigations/severity-counts",
  "/api/services",
  "/api/services/health",
  "/api/services/hidden",
  "/api/services/stale-unknown",
  "/api/services/versions",
  "/api/scan/runs",
  "/api/scan/settings",
  "/api/scan/activity",
  "/api/providers",
  "/api/notifications",
  "/api/notifications/email",
  "/api/notifications/email/recipients",
  "/api/skills",
  "/api/stacks",
  "/api/stats/kpi",
  "/api/events/recent",
  "/api/messages",
];

// Parameterized endpoints — one snapshot per entity.
function perInvestigationPaths(id: string): string[] {
  // Feedback is POST-only on the server — GET /feedback doesn't exist as a
  // route. The UI reads the rating inline from the investigation detail.
  return [
    `/api/investigations/${id}`,
    `/api/messages?investigationId=${id}`,
  ];
}

function perServicePaths(name: string): string[] {
  const enc = encodeURIComponent(name);
  return [
    `/api/services/${enc}/brief`,
    `/api/services/${enc}/metadata`,
    `/api/services/${enc}/metrics`,
    `/api/services/${enc}/scan-override`,
    `/api/services/health/history?service=${enc}&hours=24`,
    `/api/dependencies/${enc}`,
    `/api/patterns?service=${enc}`,
    // The ServiceDetail page issues two flavours of this call — match both.
    `/api/investigations?service=${enc}&limit=100`,
    `/api/investigations?service=${enc}&limit=20`,
  ];
}

function perScanRunPaths(id: string): string[] {
  return [`/api/scan/runs/${encodeURIComponent(id)}`];
}

function perProviderPaths(name: string): string[] {
  // Only /providers/:name/tools exists — there is no /providers/:name bare
  // endpoint (the provider list at /api/providers carries all the detail).
  const enc = encodeURIComponent(name);
  return [`/api/providers/${enc}/tools`];
}

// ── Server bootstrapping ────────────────────────────────────────────────────

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error(`server did not come up within ${timeoutMs}ms`);
}

function startServer(): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEMO_MODE: "true",
    PORT: String(PORT),
    DB_PATH,
    DATA_DIR,
    CONFIG_PATH: "demo/config.yaml",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_NO_WARNINGS: "1",
  };
  const child = spawn("npx", ["tsx", "src/server/index.ts"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => {
    // Quiet in CI — only surface error-level lines to keep logs readable.
    const line = d.toString();
    if (/"level":[45]0/.test(line)) process.stderr.write(line);
  });
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  return child;
}

// ── Snapshot writer ─────────────────────────────────────────────────────────

/**
 * Paths where ONE query param is the distinguishing key for the snapshot.
 * Must mirror `DISTINGUISHING_PARAM` in `src/web/lib/staticFetch.ts` —
 * the SPA and the exporter have to agree on which param ends up in the
 * filename, and everything else gets dropped.
 */
const DISTINGUISHING_PARAM: Record<string, string> = {
  "/api/patterns": "service",
  "/api/services/health/history": "service",
  "/api/messages": "investigationId",
  "/api/investigations": "service",
};

function outputPathFor(apiPath: string): string {
  const qIdx = apiPath.indexOf("?");
  const pathOnly = qIdx >= 0 ? apiPath.slice(0, qIdx) : apiPath;
  const query = qIdx >= 0 ? apiPath.slice(qIdx + 1) : "";
  const trimmed = pathOnly.endsWith("/") && pathOnly.length > 1 ? pathOnly.slice(0, -1) : pathOnly;

  const rel = trimmed.replace(/^\/api\//, "");
  const paramName = DISTINGUISHING_PARAM[trimmed];
  if (paramName && query) {
    const value = new URLSearchParams(query).get(paramName);
    if (value) {
      return join(OUT_DIR, `${rel}.${paramName}=${encodeURIComponent(value)}.json`);
    }
  }
  return join(OUT_DIR, `${rel}.json`);
}

async function snapshot(apiPath: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${BASE}${apiPath}`);
  const body = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const out = outputPathFor(apiPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  return { ok: true, status: res.status };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`[export-static] seed DB missing at ${DB_PATH} — run \`npm run seed:demo\` first.`);
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[export-static] booting seeded server on :${PORT}`);
  const child = startServer();
  const shutdown = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
  process.on("exit", shutdown);
  process.on("SIGINT", () => { shutdown(); process.exit(130); });
  process.on("SIGTERM", () => { shutdown(); process.exit(143); });

  try {
    await waitForServer(`${BASE}/api/health`);
    console.log(`[export-static] server up`);

    // Resolve IDs from the live endpoints — seed regenerates ULIDs on every run.
    const invs = (await (await fetch(`${BASE}/api/investigations?limit=50`)).json()) as { rows: Array<{ id: string }> };
    const scanRuns = (await (await fetch(`${BASE}/api/scan/runs?limit=50`)).json()) as { runs: Array<{ id: string }> };
    const services = (await (await fetch(`${BASE}/api/services`)).json()) as Array<{ name: string }>;
    const providers = (await (await fetch(`${BASE}/api/providers`)).json()) as Array<{ name: string }>;

    const paths: string[] = [
      ...STATIC_TOP,
      ...invs.rows.flatMap((i) => perInvestigationPaths(i.id)),
      ...services.flatMap((s) => perServicePaths(s.name)),
      ...scanRuns.runs.flatMap((r) => perScanRunPaths(r.id)),
      ...providers.flatMap((p) => perProviderPaths(p.name)),
    ];

    let wrote = 0;
    let missing: Array<{ path: string; status: number }> = [];
    for (const p of paths) {
      try {
        const r = await snapshot(p);
        if (r.ok) { wrote++; }
        else { missing.push({ path: p, status: r.status }); }
      } catch (err) {
        missing.push({ path: p, status: 0 });
        console.warn(`[export-static] ${p} threw:`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`[export-static] wrote ${wrote}/${paths.length} snapshots to ${OUT_DIR}`);

    // SPA fallback for GitHub Pages: Pages serves `404.html` verbatim for
    // any unmatched path. Copying `index.html` there makes client-side
    // routes like /investigations/:id, /services/:name, /scan/runs/:id
    // load the bundle instead of Pages' default 404 page.
    const indexHtml = join(dirname(OUT_DIR), "index.html");
    const fallbackHtml = join(dirname(OUT_DIR), "404.html");
    if (existsSync(indexHtml)) {
      copyFileSync(indexHtml, fallbackHtml);
      console.log(`[export-static] wrote 404.html SPA fallback`);
    } else {
      console.warn(`[export-static] index.html not found at ${indexHtml} — skipping 404 fallback`);
    }
    if (missing.length > 0) {
      console.log(`[export-static] ${missing.length} paths skipped (non-200):`);
      for (const m of missing) console.log(`  ${m.status}  ${m.path}`);
    }
    // Missing endpoints are informational, not fatal. Some may be stack-scoped
    // routes that don't apply to the default stack, or deprecated. The SPA's
    // staticFetch surfaces a clear 404 with the attempted path so operators
    // can decide whether to add them here.
  } finally {
    shutdown();
  }
}

// Force a clean exit once snapshotting completes. Without this the script
// hangs after writing all snapshots: keep-alive HTTP connections to the
// spawned demo server keep Node's event loop alive even though shutdown()
// has SIGTERM'd the child. Locally `timeout` masked this; in GitHub Actions
// the job sat idle for 10+ min before the runner orphan-killed npm.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[export-static] failed:", err);
    process.exit(1);
  });

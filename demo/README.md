# Public demo — setup and deploy

Everything needed to stand up a public read-only demo of dops-assistant on
**GitHub Pages** for free. The demo shows off the full UI against seeded
fixture data — no server, no LLM calls, no MCP providers, nothing a
visitor can break.

The seed includes a completed **Deep Investigation** (autonomous orchestrator)
run on the `checkout-api` investigation: open it and the Console replays the move
log, the cross-service causal chain (`checkout-api → payments-worker → DB
connection pool`), and the run stats — cold, from a static snapshot, with no live
WebSocket. It's the one surface that streams over WS in production, so it's
persisted as `orchestrator:*` investigation events the SPA hydrates the same way a
live reload would (see the deep-run block in `scripts/seed-demo.ts`).

## How the demo works

Two independent mechanisms cover two different scenarios:

### 1. Live demo mode (local `npm run demo`)

Setting `DEMO_MODE=true` on the Node server flips these at startup:

| Area | Behavior |
|---|---|
| All non-GET `/api/*` requests | 403 with `{error, demoMode: true, hint}` |
| WebSocket `chat` / `deep_investigate` / `rerun` / `discover*` / `scan:trigger` | Canned "demo mode" refusal, no LLM call |
| `InvestigationRunner.run()` | Throws before any DB write or LLM call |
| Scan scheduler + health poller + TTL reaper | Not started |
| Alert webhook | 503 regardless of `webhook.secret` |
| `GET /api/services/:name/brief` (LLM) + `/metrics` (live PromQL) | Empty response + `demoMode: true` |

Whitelisted writes (intentionally small):
- `POST /api/health`
- `POST /api/investigations/:id/feedback` (thumbs-up on seed investigations)

See `src/server/demo-mode.ts` for the exact allowlist.

### 2. Static demo mode (GitHub Pages)

`VITE_DEMO_STATIC=true` at build time flips the SPA into a fully server-less
mode:

- Every `/api/*` call is intercepted by `src/web/lib/staticFetch.ts` and
  served from pre-baked JSON snapshots at `dist/web/api/*.json`
- All non-GET requests synthesize a 403 response with the same shape the
  live server would return
- `window.__APP_BASE__` is seeded from `import.meta.env.BASE_URL` in
  `main.tsx` so lazy chunks resolve correctly on repo-scoped Pages URLs
- `404.html` is a copy of `index.html` so SPA routes (`/investigations/:id`,
  `/services/:name`, etc.) work on Pages' file-not-found fallback

`scripts/export-static.ts` boots the seeded server briefly, walks every GET
endpoint the SPA calls, and writes the responses as `.json` files under
`dist/web/api/`.

## Local test

```bash
npm install

# Option A: live demo server on :3000
npm run seed:demo        # writes fixtures to data-demo/
npm run demo             # DEMO_MODE=true npm run web

# Option B: static bundle (simulates GitHub Pages)
npm run build:demo-static   # build:web with VITE_DEMO_STATIC=true + seed + export
npx serve dist/web --single # any static server works; --single for SPA fallback
```

Both modes render the same UI. Option B is what actually ships to Pages.

## Deploy to GitHub Pages

**One-time setup:** Settings → Pages → Source: **GitHub Actions**

That's it. No tokens, no volumes, no secrets.

The workflow at `.github/workflows/deploy-demo.yml` handles the rest:

1. On push to `main` touching demo-relevant files (or manual
   **Actions → deploy-demo → Run workflow**), GitHub Actions runs:
   ```
   npm ci
   VITE_DEMO_STATIC=true VITE_BASE_PATH=/<repo>/ npm run build:web
   npm run seed:demo
   npm run export-static     # boots server briefly, writes api/*.json
   ```
2. `dist/web/` uploads as a Pages artifact
3. `actions/deploy-pages@v4` publishes it at
   `https://<user>.github.io/<repo>/`

First deploy takes ~3 minutes. Later deploys that hit the cached `node_modules/`
take ~90 seconds.

## Custom domain

Settings → Pages → Custom domain. Once DNS propagates, update the
`VITE_BASE_PATH` env in `deploy-demo.yml` to `/` (custom-domain Pages serve at
the root, not a sub-path).

## Refresh cadence

The seed bakes relative timestamps — "most recent investigation = 2h ago"
is computed from `Date.now()` at the moment the seed runs in the workflow.
The demo gets staler until the next push to `main`.

Recommended: trigger **Actions → deploy-demo → Run workflow** once a quarter
to refresh the timestamps. Or push any demo-relevant commit — the workflow
re-runs automatically.

## Cost

**.** GitHub Pages is free for public repos, up to 100 GB/month bandwidth
and a 1 GB site size. This demo is ~2-3 MB total (SPA bundle + JSON
snapshots). You'd need hundreds of thousands of visitors a month to bump
against the bandwidth cap.

GitHub Actions free tier includes 2000 minutes/month of runner time for
public repos; this workflow takes ~3 min per run.

## Troubleshooting

**Blank page on Pages after deploy** — check the browser console. The most
common cause is a lazy chunk 404 because `window.__APP_BASE__` wasn't seeded
at startup. Verify `VITE_BASE_PATH` in the workflow matches `/<repo>/`
(with leading and trailing slashes), and that `main.tsx` still has the
`VITE_DEMO_STATIC` check that plants `window.__APP_BASE__`.

**"Could not load investigations" on /investigations** — the SPA tried to
fetch a `/api/investigations?<query>` snapshot that the exporter didn't
write. Check the terminal output of `npm run export-static` for any `404`
paths, and add the query variant to `DISTINGUISHING_PARAM` in
`scripts/export-static.ts` (and its twin in `src/web/lib/staticFetch.ts`).

**Banner doesn't show** — verify `VITE_DEMO_STATIC=true` was set at build
time (`grep 'VITE_DEMO_STATIC' dist/web/assets/*.js` should match the
bundled value). `DemoBanner` renders on either build-time or runtime flag;
the build-time flag is what lights it up on Pages.

**SPA route 404s** — Pages only serves `404.html` for unmatched paths if
the file exists. The exporter copies `index.html` → `404.html` as its
last step; if that step was skipped (e.g. index.html was missing during
export), routes like `/investigations/:id` will show a default Pages 404
page.

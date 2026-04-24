# Public demo — setup and deploy

Everything needed to stand up a public read-only demo of dops-assistant. The
demo shows off the full UI against seeded fixture data — no real MCP
providers, no LLM calls, no way for visitors to burn your OpenAI bill.

## What demo mode does

Setting `DEMO_MODE=true` flips the following at server start:

| Area | Behavior |
|---|---|
| All non-GET `/api/*` requests | Rejected with 403 + `{error, demoMode: true, hint}` |
| WebSocket `chat` / `deep_investigate` / `discover:*` | Short-circuited with a canned "demo mode" response |
| `InvestigationRunner.run()` | Throws before any DB write or LLM call |
| Scan scheduler + health poller + TTL reaper | Not started |
| Alert webhook | Returns 503 regardless of `webhook.secret` |
| Background MCP/DB health probe | Skipped (the `/api/health` endpoint still returns cached state) |

The whitelist for writes is small and intentional:
- `POST /api/health` (liveness probes)
- `POST /api/investigations/:id/feedback` (thumbs up on seed investigations)

Everything else is blocked at the middleware layer before the request reaches
any handler. See `src/server/demo-mode.ts` for the exact allowlist.

## Local test

```bash
npm install
npm run seed:demo     # writes fixtures to data-demo/
npm run demo          # boots with DEMO_MODE=true on port 3000
```

The seed is deterministic and idempotent — `npm run seed:demo` wipes the
demo database and recreates it from scratch. Re-run quarterly (or whenever
you want to refresh "most recent investigation = 2h ago" timestamps) to
keep the demo feeling alive.

## Deploy to Fly.io

One-time setup:

```bash
# Install flyctl if you haven't
curl -L https://fly.io/install.sh | sh

# Authenticate
flyctl auth login

# Create the app (reads fly.toml for config, doesn't deploy yet)
flyctl launch --dockerfile Dockerfile.demo --no-deploy --name dops-assistant-demo --copy-config

# Create the volume for the SQLite seed DB
flyctl volumes create dops_demo_data --size 1 --region ord
```

Then deploy:

```bash
flyctl deploy --dockerfile Dockerfile.demo
```

Visit `https://dops-assistant-demo.fly.dev` (or your chosen app name).

## Automated deploys from GitHub Actions

`.github/workflows/deploy-demo.yml` redeploys on every push to `main` that
touches demo-relevant files. Add the secret once:

```bash
# Create a deploy token (no expiration is fine for an internal demo)
flyctl tokens create deploy -x 8760h
```

Paste the printed token into GitHub → Settings → Secrets and variables →
Actions → `FLY_API_TOKEN`.

Manual redeploys (e.g. quarterly reseed) are available via
**Actions → deploy-demo → Run workflow**.

## Refresh cadence

The seed bakes relative timestamps at seed time — "most recent investigation
= 2 hours ago" is computed from `Date.now()` at the moment the seed runs.
So the demo looks progressively older until you redeploy.

Recommended cadence: quarterly. Either:
- push a no-op commit to `Dockerfile.demo` to trigger the workflow, or
- trigger **Actions → deploy-demo → Run workflow** manually

Either way, the Docker image is rebuilt, which reruns the seed in the new
container and bumps all timestamps back to "now".

## Custom domain

```bash
flyctl certs create demo.your-domain.com
# then point a CNAME at dops-assistant-demo.fly.dev
flyctl certs check demo.your-domain.com
```

Update the `DemoBanner` "Run it yourself" link in
`src/web/components/DemoBanner.tsx` if you move the repo URL. The banner
defaults to the public GitHub repo.

## Cost

`shared-cpu-1x` with 1 GB memory, scale-to-zero (`auto_stop_machines = "stop"`
in `fly.toml`). Cost is dominated by the 1 GB volume and occasional wake-ups.
In practice: ~$3-5/month for a demo that gets occasional traffic. Fly's free
tier may cover it entirely for low-traffic demos.

## Troubleshooting

**"Cannot connect to MCP server stub-grafana.invalid"** — Expected. The seed
writes stub providers whose URLs don't resolve. The server tolerates the
failure; nothing calls those providers in demo mode anyway.

**`0/N services health`** — The seed writes service health into
`service_health_checks`; the ServiceHealthPoller now warms its cache from
that table at construction (see `src/server/service-health-poller.ts`). If
you see `0/N`, either the seed didn't run or `DATA_DIR`/`DB_PATH` don't
match between seed and server.

**429 rate limit on demo** — The existing global rate limiters (300 rpm per
IP on `/api`, 10 rpm on strict endpoints) still apply. If the demo gets
meaningful traffic, consider bumping `globalLimiter` in
`src/server/rate-limit.ts`.

# CLAUDE.md

## Do NOT

- **`git add .` or `git add -A`** — stage files by name. `dev/` contains secrets.
- **Commit `dev/`** — API keys, tokens, `.env` files. It's gitignored.
- **Commit `docs/plans/` or `docs/superpowers/`** — specs and plans are local working documents, gitignored. They've been accidentally committed twice before.
- **Push directly to main** — always create a feature branch and open a PR.
- **Use `npm run dev`** — that's a different entrypoint with no dotenv. Use `npm run web` for the server.
- **Run the CLI inside Claude Code** — Ink requires raw stdin which isn't available in this shell.
- **Mention the employer company or product name** — never reference the company or its product names in code, comments, docs, commit messages, or any output. Use generic terms instead.
- **Assume training data is correct about Mastra** — this project uses custom patterns (role-based MCP routing, `prepareStep` hooks, step factories) that don't match Mastra docs. Read the code.

## Project Overview

dops-assistant — AI-powered DevOps assistant integrating with Grafana via MCP for monitoring, alerting, and root cause analysis.

TypeScript, ESM (`"type": "module"`), Vitest, pino logging.

## Commands

```bash
npm run web              # Start web server (port 3000, loads dev/.env)
npm run build:web        # Build frontend (Vite → dist/web/) — MUST rebuild after src/web/ changes
npm run cli              # Terminal UI (Ink) — doesn't work inside Claude Code
npm run discover         # Run AI service discovery
npm run test:discover-eval            # Score discovery output quality (gates at 75/100)
npx tsx src/eval/rca-eval.ts          # Score RCA report quality
npx tsx src/eval/rca-eval.ts --save   # Score + save baseline
npx tsx src/eval/rca-eval.ts --compare src/eval/baselines/2026-03-22.json  # Compare to baseline
# Deep-investigation (autonomous orchestrator) quality: run a batch live, then score it
node src/eval/deep-investigation-run.mjs <incidents.json> /tmp/runs.json     # live batch (server on :3000)
npx tsx src/eval/deep-eval.ts --results /tmp/runs.json                        # score: correct / confident-wrong / category-error rates
npx tsx src/eval/deep-eval.ts --results /tmp/runs.json --save                # writes baselines/deep-latest.json
npx tsx src/eval/deep-eval.ts --results /tmp/runs.json --max-confident-wrong 0 --max-category-error 0   # CI gate
npx vitest run           # Run all tests
npx vitest run src/path  # Run a single test file
npx tsc --noEmit         # Type check
```

**"Run it" means**: `npm run build:web && CONFIG_PATH=dev/config.yaml npm run web`

**After editing server-side code** (`src/server/`, `src/agents/`, `src/mcp/`, `src/config/`, `src/workflows/`): if the server is running on port 3000, kill and restart it so changes take effect.

## Where to Look

| Task | Location |
|------|----------|
| Chat agent behavior | `src/agents/chat.ts` |
| Investigation workflow | `src/workflows/investigation.ts` → step factories in `src/workflows/steps/` |
| Add/modify a specialized agent | `src/agents/` — anomaly-detector, planner, metrics, logs, infra, synthesis, discover, changes |
| Intent classification | `src/agents/intent.ts` (AI SDK `generateText`) |
| MCP tool routing | `src/mcp/provider.ts` — role-based routing via `@mastra/mcp`, tool classification (`classifyToolAccess`) |
| Config schema | `src/config/schema.ts` — Zod schema, validated at startup |
| Service discovery | `src/agents/discover.ts` + `src/workflows/discovery.ts` → writes `services.yaml` (incl. per-service `probeRules` + top-level `globalProbeRules`) |
| Discovery eval harness | `src/eval/discover-eval.ts` — scores LLM discovery output across 4 dimensions (globals, per-service rules, PromQL parse, LogQL parse). Fixture: `src/eval/fixtures/discover-k8s-fixture.yaml` |
| Service registry | `src/services/registry.ts` — loads `services.yaml` (`{services, globalProbeRules}` shape, flat-array forward-compat), static overrides in `config.yaml` take precedence |
| Proactive scan probe | `src/server/anomaly-probe.ts` — four-track evaluator: (1) discovery globals, (2) per-service metric rules, (3) per-service log-source rules (Loki metric-queryType), (4) config.yaml defaults. Hysteresis state keyed by `${service}:${origin}:${ruleName}`, orphan GC on tick |
| Scan scheduler | `src/server/scan-scheduler.ts` — cron-driven scheduler that invokes the anomaly probe |
| Web UI | `src/web/` — React SPA (Vite). Server serves built files from `dist/web/` |
| CLI commands | `src/cli/commands/` — investigate, chat, mcp-check, discover, e2e |
| Server + WebSocket | `src/server/index.ts`, `src/server/ws-handler.ts` |
| Investigation runner | `src/server/investigation-runner.ts` — standalone executor with pluggable callbacks |
| Alert webhook | `src/server/webhook-handler.ts` — Alertmanager payloads → headless investigations |
| Health monitor | `src/server/health-monitor.ts` — background MCP/DB probes, `GET /api/health` |
| Service health poller | `src/server/service-health-poller.ts` — Prometheus polling, auto-investigate on transitions |
| K8s event poller | `src/server/k8s-event-poller.ts` — k8s API polling for transient pod-crash events, 5min cadence |
| Prometheus queries | `src/server/prometheus-query.ts` — shared PromQL execution via MCP, used by metrics API |
| Service detail page | `src/web/components/ServiceDetail.tsx` — tabbed service view (metrics, history, dependencies) |
| Service metadata | `src/server/routes.ts` — GET/PUT `/api/services/:name/metadata`, alias, tags endpoints |
| Investigation dedup | `src/server/investigation-dedup.ts` — shared dedup + concurrency guard |
| Provider registry | `src/mcp/provider-registry.ts` — config + GUI providers, CRUD, `providers.yaml` persistence |
| Provider tool management | `src/web/components/providers/ProviderToolList.tsx` — per-tool toggles, read/write badges |
| Evidence timeline | `src/web/components/EvidenceTimeline.tsx` — Metrics/Timeline tabbed evidence view |
| Smart metric extraction | `src/server/metric-extraction.ts` — backfill charts from text observations via Prometheus |
| Shared PromQL parser | `src/lib/prom-metric.ts` — `extractMetricExpression()`, imported by both server metric extraction and the web MetricsPanel empty-card titles |
| Investigation export helpers | `src/web/lib/exportInvestigation.ts` — `downloadPng` (html-to-image + font preload), `downloadMarkdown`, `copyMarkdown` |
| RCA eval harness | `src/eval/rca-eval.ts` — scores RCA reports on 5 quality dimensions, baselines in `src/eval/baselines/` |
| Deep-investigation eval | `src/eval/deep-eval.ts` (scorer: correct / confident-wrong / category-error rates) + `src/eval/deep-investigation-run.mjs` (live batch runner). Labels: `src/eval/fixtures/deep-investigation-labels.json`. The orchestrator is non-deterministic — this turns a manual batch into objective rates |
| LLM quirk workarounds | `src/agents/shared/prepare-step.ts` (`prepareStep` hook) |
| LLM retry & graceful failure | `src/agents/shared/llm-retry.ts` (`withLlmRetry`, `safeAgentRetryConfig`), `src/agents/shared/llm-errors.ts` (`LlmUnavailableError`, `isLlmUnavailable`). Tool-using agent paths only retry when `readOnlyTools: true` to avoid replaying write tool calls |
| Shared types | `src/types/` — RCA report, agent interfaces, LLM types, WebSocket protocol |
| Mastra wiring | `src/mastra/index.ts` — agent/workflow registration |

## Testing

- **Framework**: Vitest
- **Convention**: Co-located `*.test.ts` files next to source (e.g., `src/agents/chat.test.ts`)
- **Run all**: `npx vitest run`
- **Run one**: `npx vitest run src/agents/chat.test.ts`
- **Watch mode**: `npx vitest` (alias: `npm run test:watch`)
- **100+ test files** across agents, CLI commands, server, workflows, config, eval, and web components

## Dev Setup

- **Config**: `dev/config.yaml` symlinked to `config.yaml` in project root (`ln -sf dev/config.yaml config.yaml`). Must exist at root for server to start.
- **Env vars**: `dev/.env` — contains `OPENAI_API_KEY` and other secrets. Auto-loaded by server and CLI via dotenv.
- **Docker**: `docker-compose.dev.yml` — grafana-mcp with `-tls-skip-verify` for self-signed certs.
- **Specs/plans**: Save to `docs/plans/` (gitignored). Never commit.

## LLM Quirks (gpt-oss-120b)

- Produces `<|constrain|>json` hallucinated tool calls when both tools + `json_schema` responseFormat are set. Fix: only send responseFormat when tools array is empty; ignore function_calls when tools=[]
- Exhausts all tool iterations without producing JSON — needs midpoint nudge + wind-down iterations
- Grafana MCP `list_datasources` returns `{"datasources": [...]}` not a flat array — must unwrap
- All workarounds isolated in `src/agents/shared/prepare-step.ts` — removable when switching models

## Key Patterns

- **Role-based MCP routing**: `providers` in config assign roles (metrics, logs, dashboards) to MCP servers. `src/mcp/provider.ts` routes tool calls by role, not by provider name.
- **Step factories**: Investigation workflow uses factory functions in `src/workflows/steps/` that produce Mastra workflow steps. Each agent is wired as a step.
- **Graceful degradation**: Agent step failures produce empty findings rather than crashing the workflow.
- **Discovery → services.yaml**: `npm run discover` uses AI to find services via Prometheus metrics, writes `services.yaml` (per-service `probeRules` + top-level `globalProbeRules`). Static overrides in `config.yaml` take precedence. LLM-emitted rules are Zod-validated before persistence; malformed entries are dropped with a warn log.
- **Four-track scan probe**: `src/server/anomaly-probe.ts` evaluates rules in four tracks — (1) discovery-written globals (`globalProbeRules`), (2) per-service `probeRules` with `source: metric`, (3) per-service `probeRules` with `source: log` (Loki `count_over_time` via `queryType: "metric"`), (4) hardcoded `config.yaml` defaults as fallback. A `logs` fallback auto-generates LogQL from `logLabels` when discovery didn't write a log rule.
- **`prepareStep` hook**: Intercepts every LLM call to handle truncation, quirk workarounds, and tool filtering. Lives in `src/agents/shared/prepare-step.ts`.
- **LLM retry safety**: `withLlmRetry` wraps every model call with exponential backoff + jitter. Classifier (`isLlmUnavailable`) only matches AI SDK `APICallError.isRetryable` or connection-level errors — tool errors never trigger LLM retry storms. Tool-using agent paths route through `safeAgentRetryConfig(config.llmRetry, config.readOnlyTools)` so retries only engage in read-only contexts (write tools could replay otherwise). Retries exhausted → `LlmUnavailableError` → runner fails the investigation with a friendly message instead of spinning forever.
- **Investigation templates**: `quick` (metrics only), `standard` (metrics+logs), `full` (all phases + changes). Configured via `config.yaml` webhook section or GUI. See `src/workflows/investigation.ts`.
- **Alert webhook**: `POST /api/webhook/alert` receives Alertmanager payloads, validates bearer token, dedup window, and runs headless investigations. See `src/server/webhook-handler.ts`.
- **Changes evidence**: GitLab MCP provider with `"changes"` role feeds a 4th parallel evidence stream (deployments, MRs, pipelines) into investigations. See `src/agents/changes.ts`.
- **Tool classification**: `classifyToolAccess()` in `src/mcp/provider.ts` classifies MCP tools as read-only or write via name-prefix + keyword-segment heuristic. Read-only tools enabled by default; write tools require explicit opt-in. Supports both `list_pods` and `pods_list` naming conventions.

## Design System

Always read `DESIGN.md` before making any visual or UI decisions. All font choices, colors, spacing, and aesthetic direction are defined there. Do not deviate without explicit user approval. In QA mode, flag any code that doesn't match DESIGN.md.

## Security

Before every commit and PR, scan staged changes (`git diff --cached`) for secrets: `sk-`, `xoxb-`, `xapp-`, `glsa_`, `Bearer`, `password=`, base64-encoded keys, hardcoded URLs with credentials. If anything suspicious is found, STOP and alert.

### API auth posture

Writes are intentionally **unauthenticated** in the staging deploy. The trust
boundary is the VPN / private network, not the app. `config.apiKey` is unset,
so `createApiKeyMiddleware` (`src/server/auth-middleware.ts`) is a pass-through
on every non-GET request. This is a deliberate choice for an internal tool on
a trusted network, flagged and accepted during QA.

To flip auth on: set `apiKey` in config (or via `${DOPS_API_KEY}` env substitution),
update `stackFetch` in `src/web/lib/createStackFetch.ts` to send `X-API-Key` on
every request, and distribute the key to any automation that POSTs to the API.
Alertmanager webhook is already exempt via the `exemptPaths` list in
`src/server/index.ts`. Don't flip it on without coordinating the rollout,
existing scripts will 403 immediately.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

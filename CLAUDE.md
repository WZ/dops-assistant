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
npx tsx src/eval/rca-eval.ts          # Score RCA report quality
npx tsx src/eval/rca-eval.ts --save   # Score + save baseline
npx tsx src/eval/rca-eval.ts --compare src/eval/baselines/2026-03-22.json  # Compare to baseline
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
| Service discovery | `src/agents/discover.ts` + `src/workflows/discovery.ts` → writes `services.yaml` |
| Service registry | `src/services/registry.ts` — loads `services.yaml`, static overrides in `config.yaml` take precedence |
| Web UI | `src/web/` — React SPA (Vite). Server serves built files from `dist/web/` |
| CLI commands | `src/cli/commands/` — investigate, chat, mcp-check, discover, e2e |
| Server + WebSocket | `src/server/index.ts`, `src/server/ws-handler.ts` |
| Investigation runner | `src/server/investigation-runner.ts` — standalone executor with pluggable callbacks |
| Alert webhook | `src/server/webhook-handler.ts` — Alertmanager payloads → headless investigations |
| Health monitor | `src/server/health-monitor.ts` — background MCP/DB probes, `GET /api/health` |
| Service health poller | `src/server/service-health-poller.ts` — Prometheus polling, auto-investigate on transitions |
| Prometheus queries | `src/server/prometheus-query.ts` — shared PromQL execution via MCP, used by metrics API |
| Service detail page | `src/web/components/ServiceDetail.tsx` — tabbed service view (metrics, history, dependencies) |
| Service metadata | `src/server/routes.ts` — GET/PUT `/api/services/:name/metadata`, alias, tags endpoints |
| Investigation dedup | `src/server/investigation-dedup.ts` — shared dedup + concurrency guard |
| Provider registry | `src/mcp/provider-registry.ts` — config + GUI providers, CRUD, `providers.yaml` persistence |
| Provider tool management | `src/web/components/providers/ProviderToolList.tsx` — per-tool toggles, read/write badges |
| Evidence timeline | `src/web/components/EvidenceTimeline.tsx` — Metrics/Timeline tabbed evidence view |
| Smart metric extraction | `src/server/metric-extraction.ts` — backfill charts from text observations via Prometheus |
| RCA eval harness | `src/eval/rca-eval.ts` — scores RCA reports on 5 quality dimensions, baselines in `src/eval/baselines/` |
| LLM quirk workarounds | `src/agents/shared/prepare-step.ts` (`prepareStep` hook) |
| Shared types | `src/types/` — RCA report, agent interfaces, LLM types, WebSocket protocol |
| Mastra wiring | `src/mastra/index.ts` — agent/workflow registration |

## Testing

- **Framework**: Vitest
- **Convention**: Co-located `*.test.ts` files next to source (e.g., `src/agents/chat.test.ts`)
- **Run all**: `npx vitest run`
- **Run one**: `npx vitest run src/agents/chat.test.ts`
- **Watch mode**: `npx vitest` (alias: `npm run test:watch`)
- **59 test files** across agents, CLI commands, server, workflows, config, eval, and web components

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
- **Discovery → services.yaml**: `npm run discover` uses AI to find services via Prometheus metrics, writes `services.yaml`. Static overrides in `config.yaml` take precedence.
- **`prepareStep` hook**: Intercepts every LLM call to handle truncation, quirk workarounds, and tool filtering. Lives in `src/agents/shared/prepare-step.ts`.
- **Investigation templates**: `quick` (metrics only), `standard` (metrics+logs), `full` (all phases + changes). Configured via `config.yaml` webhook section or GUI. See `src/workflows/investigation.ts`.
- **Alert webhook**: `POST /api/webhook/alert` receives Alertmanager payloads, validates bearer token, dedup window, and runs headless investigations. See `src/server/webhook-handler.ts`.
- **Changes evidence**: GitLab MCP provider with `"changes"` role feeds a 4th parallel evidence stream (deployments, MRs, pipelines) into investigations. See `src/agents/changes.ts`.
- **Tool classification**: `classifyToolAccess()` in `src/mcp/provider.ts` classifies MCP tools as read-only or write via name-prefix + keyword-segment heuristic. Read-only tools enabled by default; write tools require explicit opt-in. Supports both `list_pods` and `pods_list` naming conventions.

## Design System

Always read `DESIGN.md` before making any visual or UI decisions. All font choices, colors, spacing, and aesthetic direction are defined there. Do not deviate without explicit user approval. In QA mode, flag any code that doesn't match DESIGN.md.

## Security

Before every commit and PR, scan staged changes (`git diff --cached`) for secrets: `sk-`, `xoxb-`, `xapp-`, `glsa_`, `Bearer`, `password=`, base64-encoded keys, hardcoded URLs with credentials. If anything suspicious is found, STOP and alert.

# CLAUDE.md

## Critical Rules

- **Security review before every commit and PR**: Before committing or creating a PR, scan ALL staged changes (`git diff --cached`) for secrets, API keys, tokens, passwords, credentials, private URLs, and sensitive data. Look for patterns like `sk-`, `xoxb-`, `xapp-`, `glsa_`, `Bearer`, `password=`, base64-encoded keys, and hardcoded URLs with credentials. If anything suspicious is found, STOP and alert the user. Never assume a file is safe — always check.
- **NEVER commit `dev/` folder** — it contains secrets (API keys, tokens, .env files). It is in `.gitignore`.
- **Always stage specific files by name** (`git add src/foo.ts`) — never use `git add .` or `git add -A` which can accidentally include secret files.
- **Never push directly to main**. Always create a feature branch, run tests, push to the feature branch, and open a PR.

## Project Overview

dops-assistant — an AI-powered DevOps assistant that integrates with Grafana via MCP for monitoring, alerting, and root cause analysis.

## Architecture

- **Chat agent**: `src/agents/chat.ts` — Mastra Agent with MCP tools for conversational queries
- **Investigation**: `src/workflows/investigation.ts` — Mastra workflow with parallel evidence gathering
- **Agents**: `src/agents/` — 7 specialized agents (anomaly-detector, planner, metrics, logs, infra, synthesis, chat)
- **MCP**: `src/mcp/provider.ts` — role-based tool routing via `@mastra/mcp`
- **Stream adapter**: `src/mastra/stream-adapter.ts` — bridges Mastra streaming to the WebSocket protocol
- **Server adapter**: `src/server/mastra-adapter.ts` — wraps Mastra agents into the server/CLI interfaces
- **Intent routing**: `src/agent/intent.ts` — IntentRouter classifies user messages (uses AI SDK `generateText`)
- **CLI**: `src/cli.tsx` + `src/interfaces/cli/App.tsx` — Ink React terminal UI
- **Types**: `src/types/` — shared types (RCA report, agent interfaces, LLM types)

## Dev Setup

- **Config**: `dev/config.yaml` — symlink to `config.yaml` in project root (`ln -sf dev/config.yaml config.yaml`). The config file must exist at the project root for the server to start.
- **Env vars**: `dev/.env` — contains `OPENAI_API_KEY` and other secrets. The web server (`src/server/index.ts`) auto-loads it via dotenv. The CLI (`src/cli.tsx`) also loads it via dotenv.
- `docker-compose.dev.yml` — grafana-mcp with `-tls-skip-verify` for self-signed certs

## Commands

- `npm run web` — start the web server (loads `dev/.env` automatically, serves UI on port 3000)
- `npm run build:web` — build the frontend (Vite → `dist/web/`). **Must rebuild after any change to `src/web/`** — the server serves static files from `dist/web/`, not a dev server. Restart the server after rebuilding.
- `npm run cli` — start the CLI with `NODE_TLS_REJECT_UNAUTHORIZED=0`
- `npx vitest run` — run all tests
- `npx tsc --noEmit` — type check

## Conventions

- TypeScript, ESM (`"type": "module"`)
- Vitest for tests
- pino for logging

## LLM Quirks (gpt-oss-120b)

- Produces `<|constrain|>json` hallucinated tool calls when both tools + json_schema responseFormat are set. Fix: only send responseFormat when tools array is empty; ignore function_calls from LLM when tools=[]
- Model tends to exhaust all tool iterations without producing JSON — need midpoint nudge + wind-down iterations
- Grafana MCP `list_datasources` returns `{"datasources": [...]}` not a flat array — must unwrap
- All quirk workarounds are isolated in `src/agents/shared/prepare-step.ts` (`prepareStep` hook) — removable when switching to a model without these quirks

## Investigation Workflow Patterns

- Prefetch context runs as a dedicated workflow step (`src/workflows/prefetch.ts`) before agent steps start
- Six parallel evidence agents (metrics, logs, infra, anomaly-detector, planner, synthesis) wired as Mastra agents
- Workflow degrades gracefully: agent step failures produce empty findings rather than crashing the workflow
- Truncation and LLM quirk handling isolated in `src/agents/shared/prepare-step.ts` and `src/workflows/helpers.ts`

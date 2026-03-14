# CLAUDE.md

## Critical Rules

- **Security review before every commit and PR**: Before committing or creating a PR, scan ALL staged changes (`git diff --cached`) for secrets, API keys, tokens, passwords, credentials, private URLs, and sensitive data. Look for patterns like `sk-`, `xoxb-`, `xapp-`, `glsa_`, `Bearer`, `password=`, base64-encoded keys, and hardcoded URLs with credentials. If anything suspicious is found, STOP and alert the user. Never assume a file is safe — always check.
- **NEVER commit `dev/` folder** — it contains secrets (API keys, tokens, .env files). It is in `.gitignore`.
- **Always stage specific files by name** (`git add src/foo.ts`) — never use `git add .` or `git add -A` which can accidentally include secret files.
- **Never push directly to main**. Always create a feature branch, run tests, push to the feature branch, and open a PR.

## Project Overview

dops-assistant — an AI-powered DevOps assistant that integrates with Grafana via MCP for monitoring, alerting, and root cause analysis.

## Architecture

- **LLM client**: `src/llm/openai.ts` — OpenAI Responses API *(deprecated — use Mastra agents)*
- **Chat agent**: `src/agent/core.ts` — ChatAgent, conversational + proactive modes *(deprecated)*
- **Investigation**: `src/agent/investigation.ts` — 5-phase RCA pipeline *(deprecated)*
- **CLI**: `src/cli.tsx` + `src/interfaces/cli/App.tsx` — Ink React terminal UI
- **MCP**: `src/mcp/client.ts` — Grafana MCP integration *(deprecated — see `src/mcp/provider.ts`)*

### Mastra migration (in progress — toggle with `USE_MASTRA=true`)

- **Mastra agents**: `src/agents/` — chat, planner, anomaly-detector, metrics, logs, infra, synthesis agents
- **Mastra workflow**: `src/workflows/investigation.ts` — parallel evidence-gathering workflow replacing the sequential RCA pipeline
- **MCP provider**: `src/mcp/provider.ts` — Mastra-native MCP integration via `@mastra/mcp`
- **Stream adapter**: `src/mastra/stream-adapter.ts` — bridges Mastra streaming to the WebSocket protocol
- **Server adapter**: `src/server/mastra-adapter.ts` — drop-in replacement for old agent pair in the web server
- Old files in `src/llm/`, `src/agent/`, `src/mcp/client.ts`, and `src/mcp/multi-client.ts` are marked DEPRECATED and will be deleted once `USE_MASTRA` is fully promoted

## Dev Setup

- **Config**: `dev/config.yaml` — symlink to `config.yaml` in project root (`ln -sf dev/config.yaml config.yaml`). The config file must exist at the project root for the server to start.
- **Env vars**: `dev/.env` — contains `OPENAI_API_KEY` and other secrets. The web server (`src/server/index.ts`) auto-loads it via dotenv. The CLI entrypoint (`src/index.ts`) does NOT auto-load it.
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
- **Mastra path**: all quirk workarounds are isolated in `src/agents/shared/prepare-step.ts` (`prepareStep` hook) — removable when switching to a model without these quirks

## Investigation Agent Patterns

*(Legacy path — `src/agent/investigation.ts`. Still active when `USE_MASTRA` is not set.)*

- Pre-fetch datasource UIDs and dashboard list to inject as context (avoids iteration waste)
- Evidence phases get 10 iterations, last 2 are wind-down (no tools, responseFormat enabled)
- Post-loop fresh-prompt extraction: collect tool response data → new conversation → summarize into JSON
- Truncation retry: fresh prompt with 500-char hint (don't push 50k+ truncated content back)
- Synthesis/reflection wrapped in try/catch — degrade to defaults on failure

*(Mastra path — `src/workflows/investigation.ts`. Active when `USE_MASTRA=true`.)*

- Prefetch context runs as a dedicated workflow step (`src/workflows/prefetch.ts`) before agent steps start
- Six parallel evidence agents (metrics, logs, infra, anomaly-detector, planner, synthesis) wired as Mastra agents
- Workflow degrades gracefully: agent step failures produce empty findings rather than crashing the workflow
- Truncation and LLM quirk handling isolated in `src/agents/shared/prepare-step.ts` and `src/workflows/helpers.ts`

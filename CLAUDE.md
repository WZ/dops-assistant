# CLAUDE.md

## Critical Rules

- **Security review before every commit and PR**: Before committing or creating a PR, scan ALL staged changes (`git diff --cached`) for secrets, API keys, tokens, passwords, credentials, private URLs, and sensitive data. Look for patterns like `sk-`, `xoxb-`, `xapp-`, `glsa_`, `Bearer`, `password=`, base64-encoded keys, and hardcoded URLs with credentials. If anything suspicious is found, STOP and alert the user. Never assume a file is safe — always check.
- **NEVER commit `dev/` folder** — it contains secrets (API keys, tokens, .env files). It is in `.gitignore`.
- **Always stage specific files by name** (`git add src/foo.ts`) — never use `git add .` or `git add -A` which can accidentally include secret files.

## Project Overview

dops-assistant — an AI-powered DevOps assistant that integrates with Grafana via MCP for monitoring, alerting, and root cause analysis.

## Architecture

- **LLM client**: `src/llm/openai.ts` — OpenAI Responses API
- **Chat agent**: `src/agent/core.ts` — ChatAgent, conversational + proactive modes
- **Investigation**: `src/agent/investigation.ts` — 5-phase RCA pipeline
- **CLI**: `src/cli.tsx` + `src/interfaces/cli/App.tsx` — Ink React terminal UI
- **MCP**: `src/mcp/client.ts` — Grafana MCP integration
## Dev Setup

- `docker-compose.dev.yml` — grafana-mcp with `-tls-skip-verify` for self-signed certs
- `npm run cli` — starts CLI with `NODE_TLS_REJECT_UNAUTHORIZED=0`
- dotenv auto-loads `dev/.env` with `override: true`

## Commands

- `npx vitest run` — run all tests
- `npx tsc --noEmit` — type check
- `npm run cli` — start the CLI

## Conventions

- TypeScript, ESM (`"type": "module"`)
- Vitest for tests
- pino for logging

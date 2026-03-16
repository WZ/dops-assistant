<p align="center">
  <img src="docs/img/hero-banner.svg" alt="dops-assistant" width="800"/>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"/></a>
</p>

AI-powered root cause analysis for DevOps teams. Connects to your monitoring stack via [MCP](https://modelcontextprotocol.io/) to investigate incidents, analyze metrics and logs, and deliver structured RCA reports — automatically.

## Features

- **Automated RCA pipeline** — 6-phase investigation: prefetch → anomaly detection → planning → parallel evidence gathering (metrics + logs + infra) → synthesis → report
- **MCP-agnostic** — pluggable provider architecture. Connect any MCP-compatible monitoring backend (Prometheus, Loki, Datadog, etc.) via config
- **Conversational assistant** — ask questions, get metric values, log excerpts, and dashboard links with inline charts
- **Intent routing** — regex fast-paths classify most messages without an LLM call. Only ambiguous messages hit the model
- **Web UI + CLI** — real-time investigation progress via WebSocket, or a terminal REPL with tool call visibility

## Quick Start

```bash
npm install
```

Create `config.yaml` (or copy from `config.yaml.example`):

```yaml
llm:
  model: gpt-4
  apiKey: "${OPENAI_API_KEY}"

providers:
  - name: grafana
    roles: [metrics, logs]
    mcpServer:
      transport: stdio
      command: "npx"
      args: ["-y", "@grafana/mcp-grafana"]
      env:
        GRAFANA_URL: "${GRAFANA_URL}"
        GRAFANA_API_KEY: "${GRAFANA_API_KEY}"

services:
  - name: payments-api
    metrics:
      - query: 'rate(http_requests_total{service="payments"}[5m])'
        description: "Request rate"
    logLabels:
      app: payments-api
```

```bash
# Web UI (port 3000)
npm run web

# Or terminal CLI
npm run cli
```

## How It Works

User messages are classified by an intent router. Questions go to a chat agent; incident reports trigger the investigation workflow.

<p align="center">
  <img src="docs/img/system-overview.svg" alt="System Overview" width="800"/>
</p>

### Investigation Pipeline

The investigation workflow runs 6 phases. Evidence gathering (metrics, logs, infra) runs in parallel for speed. Each agent gets only the MCP tools relevant to its role.

<p align="center">
  <img src="docs/img/investigation-flow.svg" alt="Investigation Flow" width="800"/>
</p>

## Documentation

- **[Architecture Overview](docs/architecture-overview.md)** — system design, component details, data flow, design decisions
- **[Ops Runbook](docs/runbook.md)** — MCP setup, full config reference, tuning, troubleshooting

## Development

```bash
npm run web          # web server (loads dev/.env, port 3000)
npm run cli          # terminal REPL
npm run build:web    # build frontend (Vite → dist/web/)
npx vitest run       # run tests
npx tsc --noEmit     # type check
```

## Contributing

Contributions welcome. Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)

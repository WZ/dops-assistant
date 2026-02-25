# dops-assistant

An agentic infrastructure monitoring assistant that connects to Grafana via MCP, proactively detects anomalies, performs autonomous root cause analysis, and serves as a conversational ops assistant through Slack.

## What it does

- **Proactive monitoring** — scheduled checks against your Grafana instance (Prometheus metrics, Loki logs, alerts) with structured anomaly detection
- **Autonomous RCA** — 5-phase investigation pipeline (anomaly detection, metric deep dive, log correlation, infra health, synthesis) produces structured root cause reports
- **Conversational ops assistant** — answer questions in Slack with specific metric values, log excerpts, and dashboard links
- **Intent-based routing** — Slack messages are classified as investigation requests or questions, routed to the appropriate handler
- **Per-thread memory** — conversations in Slack threads retain context across turns

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          dops-assistant                               │
│                                                                      │
│  ┌─────────────────┐    ┌─────────────────────────────────────────┐  │
│  │   Slack Bot     │    │            Agent Core                   │  │
│  │ (Socket Mode)   │    │                                         │  │
│  │                 │    │  ┌───────────┐   ┌───────────────────┐  │  │
│  │  IntentClassifier    │  │  Prompts  │   │    LLM Client     │  │  │
│  │   │             │    │  └───────────┘   │ (OpenAI, timeout, │  │  │
│  │   ├─ question ──┼───▶│                  │  retry, metrics)  │  │  │
│  │   │             │    │                  └────────┬──────────┘  │  │
│  │   └─ investigate│    │                           │             │  │
│  │        │        │    │                  ┌────────▼──────────┐  │  │
│  └────────┼────────┘    │                  │   Agentic Loop    │  │  │
│           │             │                  │   (tool calls)    │  │  │
│           ▼             │                  └────────┬──────────┘  │  │
│  ┌──────────────────┐   │                           │             │  │
│  │ Investigation    │   │                  ┌────────▼──────────┐  │  │
│  │ Agent (5-phase)  │   │                  │    MCP Client     │  │  │
│  │                  │   │                  │    (Grafana)      │  │  │
│  │ 1. Anomaly detect│   │                  │ stdio / HTTP      │  │  │
│  │ 2. Metrics   ─┐  │──▶│                  └─────────────────┘  │  │
│  │ 3. Logs      ─┼──│   └─────────────────────────────────────────┘  │
│  │ 4. Infra     ─┘  │                                                │
│  │ 5. Synthesis      │                                                │
│  └──────────────────┘                                                │
│           │                                                          │
│  ┌────────┼─────────┐                                                │
│  │Scheduler (cron)  │   ┌──────────────────────────────────────────┐ │
│  │ anomaly detect ──┼──▶│ Slack Webhook (anomaly alerts + RCA)     │ │
│  │ + RCA on anomaly │   └──────────────────────────────────────────┘ │
│  │ + deduplication  │                                                │
│  └──────────────────┘   ┌──────────────────────────────────────────┐ │
│                         │ Observability Server (:9090)              │ │
│  ┌──────────────────┐   │  /health — readiness + MCP status        │ │
│  │ Conversation     │   │  /metrics — Prometheus counters          │ │
│  │ Memory (in-mem)  │   └──────────────────────────────────────────┘ │
│  └──────────────────┘                                                │
└──────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐
│  Grafana MCP Server │  (stdio child process or StreamableHTTP)
│  - Prometheus       │
│  - Loki             │
│  - Dashboards       │
│  - Alerts           │
└─────────────────────┘
```

**Slack Bot** classifies incoming messages via **IntentClassifier** — investigation requests go to the **InvestigationAgent** (5-phase RCA pipeline), questions go to **Agent Core** (agentic tool-call loop). The **Scheduler** runs proactive checks and triggers RCA on detected anomalies. All LLM/tool calls have timeouts, retries, and Prometheus metrics. See [docs/architecture.md](docs/architecture.md) for a full component walkthrough.

## Prerequisites

- **Node.js 20+**
- **A running Grafana instance** with a service account token
- **A Slack app** with Socket Mode enabled (bot token + app token)
- **An OpenAI API key** (or a compatible endpoint)

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy the example config and fill in your values
cp config.yaml.example config.yaml

# 3. Set environment variables (or use a .env loader)
export OPENAI_API_KEY=sk-...
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_...
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export SLACK_WEBHOOK_URL=https://hooks.slack.com/...

# 4. Run in development mode
npm run dev

# 5. Or build and run in production
npm run build && npm start

# 6. Or run with Docker Compose
docker compose up --build
```

The config path defaults to `config.yaml` in the working directory. Override with `CONFIG_PATH=/path/to/config.yaml`.

## Configuration

| Section | Purpose |
|---|---|
| `llm` | Model, API key, token limit, optional custom base URL |
| `grafana.mcpServer` | MCP transport (`stdio` or `http`), command/URL, enabled tools |
| `services` | Services to monitor — PromQL queries and Loki log labels per service |
| `scheduler.anomalyCheck` | Check interval, target services, max concurrency, alert cooldown |
| `agent` | Max iterations, conversation memory config, investigation trigger phrases |
| `notifications.slack` | Webhook URL and channel for outbound anomaly/RCA alerts |
| `interfaces.slack` | Enable the Slack bot, bot token, app token |
| `timeouts` | MCP connect, LLM call, tool execution, agent iteration timeouts |
| `retry` | Max retry attempts and base delay for LLM calls |
| `observability` | Metrics server port and log level |

See [docs/runbook.md](docs/runbook.md) for a full annotated configuration reference and setup guides for Slack and Grafana.

## Documentation

- [docs/architecture.md](docs/architecture.md) — component walkthrough and design decisions
- [docs/runbook.md](docs/runbook.md) — Slack setup, Grafana MCP setup, full config reference, tuning, troubleshooting

## License

MIT

# dops-assistant

An agentic infrastructure monitoring assistant that connects to Grafana via MCP, proactively detects anomalies, and serves as a conversational ops assistant through Slack.

## What it does

- **Proactive monitoring** — runs scheduled checks against your Grafana instance (Prometheus metrics, Loki logs, alerts) and posts anomaly summaries to Slack
- **Conversational ops assistant** — answer questions in Slack and get back specific metric values, log excerpts, and dashboard links
- **Agentic tool use** — uses an LLM (OpenAI GPT-4 or compatible) in an agentic loop, calling Grafana MCP tools as needed to answer each question or check each service
- **Per-thread memory** — conversations in Slack threads retain context across turns

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       dops-assistant                            │
│                                                                 │
│  ┌─────────────────┐     ┌──────────────────────────────────┐   │
│  │  Slack Bot      │────▶│         Agent Core               │   │
│  │ (conversational)│     │                                  │   │
│  └─────────────────┘     │  ┌───────────┐   ┌─────────────┐ │   │
│                          │  │  Prompts  │   │  LLM Client │ │   │
│  ┌─────────────┐         │  └───────────┘   │  (OpenAI)   │ │   │
│  │  Scheduler  │────────▶│                  └──────┬──────┘ │   │
│  │ (proactive) │         │                         │        │   │
│  └─────────────┘         │                  ┌──────▼──────┐ │   │
│                          │                  │ Agentic Loop│ │   │
│  ┌──────────────────┐    │                  │ (tool calls)│ │   │
│  │ Conversation     │    │                  └──────┬──────┘ │   │
│  │ Memory           │    │                         │        │   │
│  └──────────────────┘    │                  ┌──────▼──────┐ │   │
│                          │                  │  MCP Client │ │   │
│                          │                  │  (Grafana)  │ │   │
│                          │                  └─────────────┘ │   │
│                          └──────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────┐                                           │
│  │ Slack Webhook    │ (outbound anomaly alerts)                 │
│  └──────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐
│  Grafana MCP Server │  (stdio child process)
│  - Prometheus       │
│  - Loki             │
│  - Dashboards       │
│  - Alerts           │
└─────────────────────┘
```

Incoming requests come from two sources: the **Scheduler** (cron-based proactive checks) and the **Slack Bot** (user messages). Both route to the **Agent Core**, which runs an agentic loop — calling the LLM, executing Grafana MCP tool calls, and iterating until a final response is produced. See [docs/architecture.md](docs/architecture.md) for a full component walkthrough.

## Prerequisites

- **Node.js 20+**
- **A running Grafana instance** with an API key
- **A Slack app** with Socket Mode enabled (bot token + app token)
- **An OpenAI API key** (or a compatible endpoint, e.g. for hosted open-source models)

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy the example config and fill in your values
cp config.yaml.example config.yaml

# 3. Set environment variables (or use a .env loader)
export OPENAI_API_KEY=sk-...
export GRAFANA_API_KEY=glsa_...
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export SLACK_WEBHOOK_URL=https://hooks.slack.com/...

# 4. Run in development mode
npm run dev

# 5. Or build and run in production
npm run build && npm start
```

The config path defaults to `config.yaml` in the working directory. Override with `CONFIG_PATH=/path/to/config.yaml`.

## Configuration

| Section | Purpose |
|---|---|
| `llm` | Model, API key, token limit, optional custom base URL |
| `grafana.mcpServer` | Command to launch the Grafana MCP server and which tools to enable |
| `services` | Services to monitor — PromQL queries and Loki log labels per service |
| `scheduler.anomalyCheck` | Check interval (e.g. `"5m"`), which services, max concurrency |
| `agent` | Max agentic loop iterations, conversation memory size and TTL |
| `notifications.slack` | Webhook URL and channel for outbound anomaly alerts |
| `interfaces.slack` | Enable the conversational Slack bot, bot token, app token |

See [docs/runbook.md](docs/runbook.md) for a full annotated configuration reference and setup guides for Slack and Grafana.

## Documentation

- [docs/architecture.md](docs/architecture.md) — component walkthrough and design decisions
- [docs/runbook.md](docs/runbook.md) — Slack setup, Grafana MCP setup, full config reference, tuning, troubleshooting

## License

MIT

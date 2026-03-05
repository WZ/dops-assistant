# dops-assistant

An agentic infrastructure monitoring assistant that connects to Grafana via MCP, proactively detects anomalies, performs autonomous root cause analysis, and serves as a conversational ops assistant through Slack.

## What it does

- **Proactive monitoring** — runs scheduled checks against your Grafana instance (Prometheus metrics, Loki logs, alerts) and posts anomaly summaries to Slack
- **Conversational ops assistant** — answer questions in Slack and get back specific metric values, log excerpts, and dashboard links
- **Service auto-discovery** — automatically discovers services via Consul metrics in Prometheus, probes for RED metrics and Loki log labels, and populates your config
- **Agentic tool use** — uses an LLM (OpenAI GPT-4 or compatible) in an agentic loop, calling Grafana MCP tools as needed to answer each question or check each service
- **Per-thread memory** — conversations in Slack threads retain context across turns

## Architecture

```mermaid
graph TD
    subgraph dops-assistant
        SlackBot["Slack Bot<br/>(Socket Mode)"]
        IC["IntentClassifier"]
        AC["Agent Core<br/>(agentic tool-call loop)"]
        IA["InvestigationAgent<br/>(5-phase RCA)"]
        LLM["LLM Client<br/>(OpenAI + timeout/retry)"]
        MCP["MCP Client<br/>(Grafana)"]
        Sched["Scheduler<br/>(cron + deduplication)"]
        Webhook["Slack Webhook<br/>(alerts + RCA blocks)"]
        Obs["Observability Server<br/>(:9090 /health /metrics)"]
        Mem["Conversation Memory"]

        SlackBot --> IC
        IC -- question --> AC
        IC -- investigate --> IA
        AC --> LLM
        LLM --> MCP
        IA --> LLM
        Sched -- anomaly detected --> IA
        Sched -- alert --> Webhook
        SlackBot --> Mem
    end

    MCP --> Grafana["Grafana MCP Server<br/>(stdio or StreamableHTTP)<br/>Prometheus · Loki · Dashboards · Alerts"]
```

**Slack Bot** classifies incoming messages via **IntentClassifier** — investigation requests go to the **InvestigationAgent** (5-phase parallel RCA pipeline), questions go to **Agent Core** (agentic tool-call loop). The **Scheduler** runs proactive checks and triggers RCA on detected anomalies. All LLM/tool calls have timeouts, retries, and Prometheus metrics. See [docs/architecture.md](docs/architecture.md) for a full component walkthrough.

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

# 4. (Optional) Auto-discover services from Consul/Prometheus
npm run discover

# 5. Run in development mode
npm run dev

# 6. Or build and run in production
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
| `discovery` | Auto-discovery settings — `autoRefresh`, `excludeServices`, `consulMetric` |
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

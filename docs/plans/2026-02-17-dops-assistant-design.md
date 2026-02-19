# Dops Assistant — MVP Design

## Overview

An agentic infrastructure monitoring application that connects to Grafana via MCP (Model Context Protocol) to proactively detect anomalies and serve as a conversational ops assistant through Slack.

## MVP Scope

### In Scope

1. **YAML configuration** — Define services, metrics, check intervals, Slack/LLM settings
2. **Grafana MCP client** — Connect to Grafana MCP server, call Prometheus/Loki tools
3. **Agent core** — Agentic LLM loop using OpenAI GPT-4
4. **Scheduler** — Run proactive anomaly checks on a cron interval
5. **Slack notification** — Post anomaly summaries via webhook
6. **Slack bot (conversational)** — Users ask questions in Slack, agent queries Grafana and responds
7. **Conversation memory** — Context retained within Slack threads

### Out of Scope (Future Iterations)

- Alert webhook receiver (reactive investigation mode)
- CLI / web chat interfaces
- Web GUI (chat, anomaly feed, service dashboard, config management)
- Multi-LLM provider support (MVP uses OpenAI only)
- Dashboard rendering/screenshots

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Monitor Agent                               │
│                                                                 │
│  ┌─────────────────┐     ┌──────────────────────────────────┐   │
│  │  Slack Bot      │────▶│         Agent Core               │   │
│  │ (conversational)│     │                                  │   │
│  └─────────────────┘     │  ┌───────────┐   ┌─────────────┐ │   │
│                          │  │  Router   │──▶│  LLM Client │ │   │
│  ┌─────────────┐         │  └───────────┘   │  (OpenAI)   │ │   │
│  │  Scheduler  │────────▶│                  └──────┬──────┘ │   │
│  │ (proactive) │         │                         │        │   │
│  └─────────────┘         │                  ┌──────▼──────┐ │   │
│                          │                  │ Agentic Loop│ │   │
│                          │                  │ (tool calls)│ │   │
│                          │                  └──────┬──────┘ │   │
│                          │                         │        │   │
│                          │                  ┌──────▼──────┐ │   │
│                          │                  │  MCP Client │ │   │
│                          │                  │  (Grafana)  │ │   │
│                          │                  └─────────────┘ │   │
│                          └──────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────┐                                           │
│  │ Slack Webhook    │ (outbound anomaly alerts)                 │
│  │ Notifier         │                                           │
│  └──────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐
│  Grafana MCP Server │  (external process, launched via stdio)
│  - Prometheus tools │
│  - Loki tools       │
│  - Dashboard tools  │
│  - Alert tools      │
└─────────────────────┘
```

## Component Design

### Agent Core

The agentic LLM loop is the heart of the system. It:

1. Receives a task (user message from Slack, or scheduled anomaly check)
2. Builds a system prompt with: agent persona, available MCP tools, service context from YAML config
3. Sends to OpenAI GPT-4 with tool definitions
4. If the LLM returns tool calls → executes them via MCP client → sends results back to LLM
5. Loops until the LLM returns a final text response (max iterations configurable, default 20)
6. Delivers the response (Slack message or notification)

**System prompts per mode:**
- **Proactive mode:** "You are a monitoring agent. Query the following services and report any anomalies. Here are the expected metrics and thresholds..."
- **Conversational mode:** "You are an ops assistant. Answer the user's question using the available Grafana tools. Provide specific data and link to dashboards when possible."

### MCP Client

- Uses `@modelcontextprotocol/sdk` to connect to the Grafana MCP server
- Launches the Grafana MCP server as a child process via stdio
- Discovers available tools at startup
- Formats MCP tools as OpenAI function definitions for the LLM
- Executes tool calls and returns results

### Scheduler

- Uses `node-cron` for interval-based scheduling
- For each configured service, creates an agent task with the proactive system prompt
- Runs checks in parallel across services (concurrency limit configurable)

### Slack Bot (Conversational)

- Uses `@slack/bolt` in Socket Mode
- Listens for mentions and DMs
- Each Slack thread maps to a conversation with memory
- Sends user messages to the Agent Core, posts responses back to the thread

### Conversation Memory

- In-memory store keyed by Slack thread ID
- Stores message history (user + assistant + tool calls/results)
- Configurable max history length (default: 20 messages per thread)
- TTL-based expiry (default: 1 hour of inactivity)

### Slack Notification (Outbound)

- Simple webhook POST for anomaly alerts
- Structured message with: service name, severity, summary, key metrics, Grafana dashboard link

### Configuration

```yaml
llm:
  provider: openai
  model: gpt-4
  maxTokens: 4096
  apiKey: "${OPENAI_API_KEY}"

grafana:
  mcpServer:
    command: "npx"
    args: ["@grafana/mcp-grafana"]
    env:
      GRAFANA_URL: "https://grafana.example.com"
      GRAFANA_API_KEY: "${GRAFANA_API_KEY}"
    enabledTools:
      - "query_prometheus"
      - "query_loki"
      - "search_dashboards"
      - "get_alerts"

services:
  - name: payments-api
    metrics:
      - query: 'rate(http_requests_total{service="payments"}[5m])'
        description: "Request rate"
      - query: 'histogram_quantile(0.99, rate(http_duration_seconds_bucket{service="payments"}[5m]))'
        description: "P99 latency"
    logLabels:
      app: payments-api

scheduler:
  anomalyCheck:
    interval: "5m"
    services: ["payments-api"]
    maxConcurrency: 3

agent:
  maxIterations: 20
  conversationMemory:
    maxMessages: 20
    ttlMinutes: 60

notifications:
  slack:
    webhookUrl: "${SLACK_WEBHOOK_URL}"
    channel: "#ops-alerts"

interfaces:
  slack:
    enabled: true
    botToken: "${SLACK_BOT_TOKEN}"
    appToken: "${SLACK_APP_TOKEN}"
```

## Project Structure

```
monitor-agent/
├── src/
│   ├── index.ts              # Entry point
│   ├── config/
│   │   ├── loader.ts         # YAML config loading & validation
│   │   └── schema.ts         # Zod schema for config
│   ├── agent/
│   │   ├── core.ts           # Agentic loop (LLM + MCP tool execution)
│   │   ├── prompts.ts        # System prompts per mode
│   │   └── types.ts          # AgentTask, AgentResponse types
│   ├── llm/
│   │   └── openai.ts         # OpenAI GPT-4 adapter
│   ├── mcp/
│   │   └── client.ts         # MCP client (connect, discover tools, execute)
│   ├── scheduler/
│   │   └── scheduler.ts      # Cron-based proactive check runner
│   ├── interfaces/
│   │   └── slack.ts          # Slack bot (Socket Mode via @slack/bolt)
│   ├── memory/
│   │   └── conversation.ts   # In-memory conversation store
│   └── notifications/
│       └── slack-webhook.ts  # Outbound Slack webhook for anomaly alerts
├── config.yaml
├── package.json
├── tsconfig.json
└── tests/
```

## Key Dependencies

- `@modelcontextprotocol/sdk` — MCP client SDK
- `openai` — OpenAI GPT-4 SDK
- `zod` — Config validation
- `yaml` — YAML parsing
- `@slack/bolt` — Slack bot framework
- `node-cron` — Scheduling
- `pino` — Structured logging

## Key Decisions

- **Grafana MCP only** — No separate Prometheus MCP needed. Grafana MCP already includes PromQL querying, Loki, dashboards, alerts, and more through a single connection.
- **OpenAI GPT-4 for MVP** — Single LLM provider to keep things simple. Multi-provider support is a future enhancement.
- **In-memory conversation store** — No database for MVP. Conversations are ephemeral with TTL-based expiry. Persistent storage is a future enhancement.
- **Slack Socket Mode** — No public URL required for the bot. Simpler deployment than webhook-based Slack apps.
- **Plugin-based architecture** — While the MVP has a single LLM provider and single MCP server, the interfaces (LLM client, MCP client) are designed for future extensibility.

## Future Enhancements

1. Alert webhook receiver (reactive investigation mode)
2. Web GUI (chat, anomaly feed, service dashboard, config management)
3. Multi-LLM provider support (Claude, local models)
4. CLI interface
5. Persistent conversation storage (SQLite/Postgres)
6. Additional MCP servers (PagerDuty, GitHub for deploy correlation)
7. Auto-remediation actions

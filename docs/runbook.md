# Ops Runbook

## Grafana MCP setup

dops-assistant launches the Grafana MCP server as a child process using the command in `grafana.mcpServer.command`. By default this is:

```bash
npx -y @grafana/mcp-grafana
```

The MCP server connects to your Grafana instance using two environment variables:

| Variable | Description |
|---|---|
| `GRAFANA_URL` | Base URL of your Grafana instance, e.g. `https://grafana.example.com` |
| `GRAFANA_API_KEY` | A Grafana service account token with `Viewer` role minimum |

**To create a Grafana API key:**

1. In Grafana, go to *Administration → Service Accounts*.
2. Click **Add service account**, give it a name, set role to `Viewer`.
3. Click **Add service account token**, copy the token.

**Enabled tools:** The `enabledTools` list controls which Grafana MCP tools the LLM can call. Restrict this to what your use case needs:

| Tool | What it does |
|---|---|
| `query_prometheus` | Run PromQL queries |
| `query_loki` | Query Loki logs |
| `search_dashboards` | Find dashboards by name/tag |
| `get_alerts` | List active alerts |

---

## Configuration reference

Full annotated `config.yaml`:

```yaml
llm:
  # Which model to use. Any OpenAI-compatible model name works.
  model: gpt-4

  # Max tokens per LLM response.
  maxTokens: 4096

  # Your OpenAI API key. Use ${OPENAI_API_KEY} to read from env.
  apiKey: "${OPENAI_API_KEY}"

  # Optional: override the API endpoint for OpenAI-compatible providers.
  # baseURL: "https://your-provider.example.com/v1"

grafana:
  mcpServer:
    # Command to launch the Grafana MCP server.
    command: "npx"
    args: ["-y", "@grafana/mcp-grafana"]

    # Environment variables passed to the MCP server process.
    env:
      GRAFANA_URL: "https://grafana.example.com"
      GRAFANA_API_KEY: "${GRAFANA_API_KEY}"

    # Restrict which tools the LLM can call. Omit to allow all tools.
    enabledTools:
      - "query_prometheus"
      - "query_loki"
      - "search_dashboards"
      - "get_alerts"

# Service auto-discovery. Discovers services via Consul metrics in Prometheus.
discovery:
  # Run discovery at startup and merge with static services.
  autoRefresh: false

  # Services to exclude from discovery results.
  excludeServices:
    - consul
    - prometheus
    - grafana
    - node-exporter
    - alertmanager

  # Prometheus metric used to discover services (Consul service health).
  consulMetric: "consul_catalog_service_node_healthy"

# Services to monitor proactively.
# Populate manually, or run `npm run discover` to auto-populate from Prometheus/Loki.
services:
  - name: payments-api
    # PromQL queries the agent will check for each service.
    metrics:
      - query: 'rate(http_requests_total{service="payments"}[5m])'
        description: "Request rate"
      - query: 'histogram_quantile(0.99, rate(http_duration_seconds_bucket{service="payments"}[5m]))'
        description: "P99 latency"
    # Loki log label selectors for this service.
    logLabels:
      app: payments-api

agent:
  # Max number of LLM + tool-call iterations before giving up.
  maxIterations: 20

  conversationMemory:
    # Max messages to retain per conversation.
    maxMessages: 20

    # Minutes of inactivity before a conversation's memory is evicted.
    ttlMinutes: 60
```

---

## Environment variables

| Variable | Where to get it |
|---|---|
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `GRAFANA_API_KEY` | Grafana → Administration → Service Accounts → Add token |

---

## Running in production

**Build and start:**

```bash
npm run build
npm start
```

**With a custom config path:**

```bash
CONFIG_PATH=/etc/dops-assistant/config.yaml npm start
```

**Process management options:**

```bash
# pm2
pm2 start dist/index.js --name dops-assistant

# systemd (create /etc/systemd/system/dops-assistant.service)
# [Service]
# ExecStart=/usr/bin/node /opt/dops-assistant/dist/index.js
# WorkingDirectory=/opt/dops-assistant
# EnvironmentFile=/opt/dops-assistant/.env
# Restart=on-failure
```

The process handles `SIGINT` and `SIGTERM` for graceful shutdown — it destroys conversation memory and closes the Grafana MCP connection before exiting.

---

## Tuning

### Max iterations (`agent.maxIterations`)

Controls how many LLM + tool-call rounds the agent can take before giving up. Increase if the agent is hitting the limit on complex multi-service checks. The default of 20 is generous for most use cases.

### Conversation memory (`agent.conversationMemory`)

- `maxMessages` — how many messages to retain per conversation. Higher values give the LLM more context but increase token usage on each turn. 20 is a good default.
- `ttlMinutes` — how long a conversation stays in memory after the last message. 60 minutes works well for ops workflows.

### Service discovery (`discovery`)

- `autoRefresh` — set to `true` to run discovery at every startup. Discovered services are merged with static config in memory (does not write to disk). Set to `false` and use `npm run discover` for a one-time CLI-driven discovery that writes back to your config file.
- `excludeServices` — infrastructure services (consul, prometheus, grafana, etc.) that should not appear in discovery results. Case-insensitive.
- `consulMetric` — the Prometheus metric used to enumerate services. Defaults to `consul_catalog_service_node_healthy`. Change this if your service registry uses a different metric.

---

## Troubleshooting

### MCP connection fails at startup

```
Error: spawn npx ENOENT
```

`npx` is not in PATH. Either install Node.js globally or specify the full path to `npx` in `grafana.mcpServer.command`.

```
Error: MCP client not connected
```

The Grafana MCP server process failed to start. Check that `GRAFANA_URL` and `GRAFANA_API_KEY` are set correctly and that the Grafana instance is reachable from the machine running dops-assistant.

### OpenAI rate limits

If you see `429 Too Many Requests` errors in logs:
- Switch to a higher-tier OpenAI plan or use a different model via `llm.baseURL`.

### Discovery finds no services

- Confirm `consul_catalog_service_node_healthy` (or your configured `consulMetric`) exists in Prometheus. Run `query_prometheus` with `consul_catalog_service_node_healthy` to verify.
- Check that `discovery.excludeServices` isn't filtering out the services you expect to find.
- Increase `agent.maxIterations` if the discovery agent is running out of iterations before completing its probes.

### Agent hits maxIterations

If you see "Reached maximum iterations" in responses, the agent is taking too many tool calls to answer the question. Options:
- Increase `agent.maxIterations` (default: 20).
- Reduce `enabledTools` to limit how many tools the LLM tries to use.

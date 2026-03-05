# Ops Runbook

## Slack app setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**.

2. **Enable Socket Mode:**
   - Under *Settings → Socket Mode*, toggle it on.
   - Create an app-level token with the `connections:write` scope. This is your `SLACK_APP_TOKEN` (`xapp-...`).

3. **Set bot scopes:**
   Under *OAuth & Permissions → Scopes → Bot Token Scopes*, add:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`

4. **Enable event subscriptions:**
   Under *Event Subscriptions*, enable events and subscribe to these bot events:
   - `app_mention`
   - `message.im`

5. **Install the app** to your workspace under *OAuth & Permissions → Install to Workspace*. Copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN` (`xoxb-...`).

6. **Get the webhook URL** for anomaly alerts:
   Under *Incoming Webhooks*, activate webhooks and add a new webhook to the channel where you want alerts posted. This is your `SLACK_WEBHOOK_URL`.

---

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

scheduler:
  anomalyCheck:
    # How often to run proactive checks. Supports "Xm" (minutes) or "Xh" (hours).
    interval: "5m"

    # Which services to check. Omit to check all services.
    services:
      - payments-api

    # Max number of service checks running in parallel at once.
    maxConcurrency: 3

agent:
  # Max number of LLM + tool-call iterations before giving up.
  maxIterations: 20

  conversationMemory:
    # Max messages to retain per Slack thread.
    maxMessages: 20

    # Minutes of inactivity before a thread's memory is evicted.
    ttlMinutes: 60

notifications:
  slack:
    # Slack incoming webhook URL for anomaly alerts.
    webhookUrl: "${SLACK_WEBHOOK_URL}"

    # Channel name (informational only — the webhook targets its own channel).
    channel: "#ops-alerts"

interfaces:
  slack:
    # Set to true to enable the conversational Slack bot.
    enabled: true
    botToken: "${SLACK_BOT_TOKEN}"
    appToken: "${SLACK_APP_TOKEN}"
```

---

## Environment variables

| Variable | Where to get it |
|---|---|
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `GRAFANA_API_KEY` | Grafana → Administration → Service Accounts → Add token |
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token |
| `SLACK_APP_TOKEN` | Slack app → Settings → Socket Mode → App-level token |
| `SLACK_WEBHOOK_URL` | Slack app → Incoming Webhooks → Add webhook |

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

The process handles `SIGINT` and `SIGTERM` for graceful shutdown — it stops the scheduler, disconnects the Slack bot, and closes the Grafana MCP connection before exiting.

---

## Tuning

### Check interval (`scheduler.anomalyCheck.interval`)

Lower values = faster anomaly detection, higher Grafana and OpenAI API usage.

| Use case | Recommended value |
|---|---|
| Active incident response | `"1m"` |
| Normal operations | `"5m"` |
| Low-priority / cost-sensitive | `"15m"` or `"1h"` |

### Max iterations (`agent.maxIterations`)

Controls how many LLM + tool-call rounds the agent can take before giving up. Increase if the agent is hitting the limit on complex multi-service checks. The default of 20 is generous for most use cases.

### Conversation memory (`agent.conversationMemory`)

- `maxMessages` — how many messages to retain per thread. Higher values give the LLM more context but increase token usage on each turn. 20 is a good default.
- `ttlMinutes` — how long a thread stays in memory after the last message. 60 minutes works well for ops workflows; increase if your team has long-running incident threads.

### Service discovery (`discovery`)

- `autoRefresh` — set to `true` to run discovery at every startup. Discovered services are merged with static config in memory (does not write to disk). Set to `false` and use `npm run discover` for a one-time CLI-driven discovery that writes back to your config file.
- `excludeServices` — infrastructure services (consul, prometheus, grafana, etc.) that should not appear in discovery results. Case-insensitive.
- `consulMetric` — the Prometheus metric used to enumerate services. Defaults to `consul_catalog_service_node_healthy`. Change this if your service registry uses a different metric.

### Concurrency (`scheduler.anomalyCheck.maxConcurrency`)

Controls how many service checks run in parallel per cron tick. Set this based on how many Grafana MCP calls you're comfortable making simultaneously. Default of 3 is conservative.

---

## Anomaly detection

The scheduler uses a simple keyword heuristic: any agent response that does NOT contain "healthy" or "no anomalies" (case-insensitive) is treated as an anomaly and triggers a Slack alert.

The agent is prompted in proactive mode to:
- Check each service's metrics and recent logs
- Describe any anomalies with service name, metric, current value vs expected, and severity (low/medium/high)
- Say "everything looks healthy" explicitly when there are no issues

**What a Slack alert looks like:**

The alert is a Slack Block Kit message containing:
- Service name and severity (🟡 low / 🟠 medium / 🔴 high)
- The agent's summary of what it found
- Key metric values if included in the response
- A "View Dashboard" button if the agent found and linked a dashboard

**Known limitations:**

- The heuristic produces false positives if the agent's response to an error or timeout doesn't contain either keyword. Error messages like "Unable to connect to Grafana" will trigger an alert.
- Severity is currently always set to `medium` by the scheduler regardless of what the agent says in its text response. Future enhancement: parse severity from the response.

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

### Slack bot not responding

- Confirm Socket Mode is enabled in your Slack app settings.
- Confirm the `SLACK_APP_TOKEN` starts with `xapp-` and `SLACK_BOT_TOKEN` starts with `xoxb-`.
- Check that the bot has been invited to the channel (for mentions).
- Check pino logs for Bolt connection errors.

### No anomaly alerts firing

- Confirm `notifications.slack.webhookUrl` is set and the webhook is active.
- Check that `scheduler.anomalyCheck` is configured and `interfaces.slack.enabled` is not the only thing set (scheduler and Slack bot are independent).
- Confirm the agent response for healthy services contains "healthy" — if it doesn't, every check will trigger a false alert.

### OpenAI rate limits

If you see `429 Too Many Requests` errors in logs:
- Reduce `scheduler.anomalyCheck.maxConcurrency` to limit parallel LLM calls.
- Increase `scheduler.anomalyCheck.interval` to reduce frequency.
- Switch to a higher-tier OpenAI plan or use a different model via `llm.baseURL`.

### Discovery finds no services

- Confirm `consul_catalog_service_node_healthy` (or your configured `consulMetric`) exists in Prometheus. Run `query_prometheus` with `consul_catalog_service_node_healthy` to verify.
- Check that `discovery.excludeServices` isn't filtering out the services you expect to find.
- Increase `agent.maxIterations` if the discovery agent is running out of iterations before completing its probes.

### Agent hits maxIterations

If you see "Reached maximum iterations" in Slack responses, the agent is taking too many tool calls to answer the question. Options:
- Increase `agent.maxIterations` (default: 20).
- Reduce the number of services in `scheduler.anomalyCheck.services` to check fewer at once.
- Reduce `enabledTools` to limit how many tools the LLM tries to use.

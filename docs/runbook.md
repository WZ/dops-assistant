# Ops Runbook

## Grafana MCP setup

dops-assistant connects to Grafana via MCP (Model Context Protocol). Each MCP provider is configured in the `providers` section of `config.yaml` and can use either stdio (child process) or HTTP transport.

The Grafana MCP server needs two environment variables:

| Variable | Description |
|---|---|
| `GRAFANA_URL` | Base URL of your Grafana instance, e.g. `https://grafana.example.com` |
| `GRAFANA_API_KEY` | A Grafana service account token with `Viewer` role minimum |

**To create a Grafana API key:**

1. In Grafana, go to *Administration → Service Accounts*.
2. Click **Add service account**, give it a name, set role to `Viewer`.
3. Click **Add service account token**, copy the token.

---

## Configuration reference

Full annotated `config.yaml`:

```yaml
llm:
  # Which model to use. Any OpenAI-compatible model name works.
  model: gpt-4

  # Your API key. Use ${OPENAI_API_KEY} to read from env.
  apiKey: "${OPENAI_API_KEY}"

  # Optional: override the API endpoint for OpenAI-compatible providers.
  # baseURL: "https://your-provider.example.com/v1"

  # Optional: retry policy for transient LLM-call failures (network errors,
  # 408/409/429/5xx from the provider). Tool errors are NOT retried — only
  # the LLM API itself.
  retry:
    maxAttempts: 8         # 1..15, default 8
    initialDelayMs: 2000   # first backoff, default 2s
    maxDelayMs: 60000      # cap on exponential growth, default 60s
    jitterPercent: 0.3     # 0..2, fraction of base delay added as jitter
  #
  # Note: agent paths (anomaly/evidence/planning/synthesis) only retry when
  # the investigation runs in read-only-tools mode (e.g. webhook-triggered).
  # Manual investigations that allow write tools effectively get
  # maxAttempts=1 to avoid replaying tool calls.

# MCP providers. Each provider connects to an MCP server and declares
# which roles it fulfills.
# Available roles: metrics, logs, dashboards, dependencies, infrastructure, changes
providers:
  - name: grafana
    roles: [metrics, logs, dashboards]
    mcpServer:
      transport: stdio
      command: "npx"
      args: ["-y", "@grafana/mcp-grafana"]
      env:
        GRAFANA_URL: "${GRAFANA_URL}"
        GRAFANA_API_KEY: "${GRAFANA_API_KEY}"
      # Optional: restrict which tools are available (read-only tools enabled by default)
      # enabledTools: [query_prometheus, list_datasources, search_dashboards]

# Services to monitor. Each service defines PromQL metrics and Loki log labels
# for the investigation agents to query.
services:
  - name: payments-api
    metrics:
      - query: 'rate(http_requests_total{service="payments"}[5m])'
        description: "Request rate"
      - query: 'histogram_quantile(0.99, rate(http_duration_seconds_bucket{service="payments"}[5m]))'
        description: "P99 latency"
    logLabels:
      app: payments-api

agent:
  # Max number of LLM + tool-call iterations per agent step.
  maxIterations: 20

  conversationMemory:
    # Max messages to retain per conversation thread.
    maxMessages: 20
    # Minutes of inactivity before a conversation is evicted.
    ttlMinutes: 60

# Investigation skills — markdown runbooks injected into agent prompts
# when they match the service/alert being investigated.
skills:
  directory: "skills"
```

---

## Environment variables

| Variable | Where to set it |
|---|---|
| `OPENAI_API_KEY` | `dev/.env` (auto-loaded by server and CLI) |
| `GRAFANA_URL` | `dev/.env` or provider env config |
| `GRAFANA_API_KEY` | `dev/.env` or provider env config |

---

## Running

### Development

```bash
# Web server (loads dev/.env, serves UI on port 3000)
npm run web

# CLI (terminal REPL)
npm run cli

# Build frontend (must rebuild after changes to src/web/)
npm run build:web
```

### Production

```bash
# Build and start
npm run build:web
npm start

# With a custom config path
CONFIG_PATH=/etc/dops-assistant/config.yaml npm start
```

**Process management:**

```bash
# pm2
pm2 start dist/server/index.js --name dops-assistant

# systemd
# [Service]
# ExecStart=/usr/bin/node /opt/dops-assistant/dist/server/index.js
# WorkingDirectory=/opt/dops-assistant
# EnvironmentFile=/opt/dops-assistant/.env
# Restart=on-failure
```

The server handles `SIGINT` and `SIGTERM` for graceful shutdown.

---

## Tuning

### Max iterations (`agent.maxIterations`)

Controls how many LLM + tool-call rounds each agent step can take. The investigation workflow's evidence agents run up to 10 iterations each. Increase if agents are consistently hitting the limit.

### Conversation memory (`agent.conversationMemory`)

- `maxMessages` — messages retained per thread. Higher values give more context but increase token usage. Default: 20.
- `ttlMinutes` — inactivity timeout. Default: 60.

### LLM quirk handling

The investigation agents include workarounds for model-specific quirks (hallucinated tool calls, failure to produce JSON). These are isolated in `src/agents/shared/prepare-step.ts` and can be disabled by setting `useQuirkHandling: false` in the workflow config, or removed entirely when switching to a model without these issues.

---

## Troubleshooting

### MCP connection fails at startup

```
Error: spawn npx ENOENT
```

`npx` is not in PATH. Install Node.js globally or use the full path in the provider's `mcpServer.command`.

### No tools discovered

If the server logs `MCP connected (0 tools)`:
- Check that `GRAFANA_URL` and `GRAFANA_API_KEY` are set correctly
- Verify the Grafana instance is reachable
- Try running the MCP server manually: `GRAFANA_URL=... GRAFANA_API_KEY=... npx -y @grafana/mcp-grafana`

### Investigation produces empty evidence

- Check that the service has configured `metrics` and `logLabels` in config
- The prefetch step probes for working Loki log selectors — if no logs exist for the service, log evidence will be empty
- Enable debug logging: `DOPS_DEBUG=1 npm run web`

### Agent hits maxIterations

If evidence phases produce poor results, the agent may be running out of iterations:
- Increase `agent.maxIterations`
- Check that tool allowlists in `src/workflows/tool-utils.ts` include the tools your provider exposes

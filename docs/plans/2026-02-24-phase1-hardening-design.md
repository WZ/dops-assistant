# Phase 1 Hardening Design

**Date:** 2026-02-24
**Status:** Approved

## Goal

Harden the dops-assistant MVP into a production-ready service. No new user-facing features. Focus on reliability, observability, and replacing fragile heuristics with structured outputs.

## Scope

1. Timeouts at every async boundary
2. Retry with exponential backoff
3. Correlation IDs through the full request path
4. Prometheus metrics + health check HTTP server
5. Enhanced structured logging (log level configurable)
6. Structured anomaly detection (replace keyword heuristic)
7. Alert deduplication with configurable cooldown

## Approach

Option A: incremental, in-place hardening. Add cross-cutting utilities alongside existing modules. Use `prom-client` for metrics (no custom Prometheus exposition format). No new abstraction layers.

---

## Component Design

### 1. Cross-cutting utilities (`src/utils/`)

**`src/utils/timeout.ts`**

```ts
withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>
```

Races a promise against a timer. On timeout throws `TimeoutError` with the given label (e.g. `"MCP connect"`, `"LLM chat"`, `"tool:query_prometheus"`).

Applied at:
- `McpClient.connect()` — default 30 s
- `LlmClient.chat()` — default 60 s
- `McpClient.executeTool()` per tool call — default 30 s
- Agent loop per iteration — default 90 s

**`src/utils/retry.ts`**

```ts
withRetry<T>(fn: () => Promise<T>, opts: {
  maxAttempts: number,
  baseDelayMs: number,
  retryOn?: (err: unknown) => boolean
}): Promise<T>
```

Exponential backoff with jitter. Default `retryOn` retries on HTTP 429, 503, and network errors. Non-retryable errors (400, 401, content filter) propagate immediately.

Applied at:
- `LlmClient.chat()` — up to 3 attempts
- `sendAnomalyAlert()` — up to 3 attempts

---

### 2. Observability (`src/observability/`)

**`src/observability/metrics.ts`**

Prometheus metrics via `prom-client`, exported as singletons:

| Metric | Type | Labels |
|---|---|---|
| `agent_runs_total` | Counter | `status: success\|error\|timeout\|truncated` |
| `agent_iterations` | Histogram | — (buckets: 1,3,5,10,20) |
| `llm_calls_total` | Counter | `status: success\|error\|rate_limited` |
| `llm_tokens_used_total` | Counter | `type: prompt\|completion` |
| `tool_calls_total` | Counter | `tool, status: success\|error\|timeout` |
| `tool_duration_seconds` | Histogram | `tool` |
| `scheduler_checks_total` | Counter | `service, status: anomaly\|healthy\|error` |
| `slack_messages_total` | Counter | `status: success\|error` |
| `alert_notifications_total` | Counter | `status: success\|error\|deduplicated` |

**`src/observability/server.ts`**

HTTP server on port 9090 (configurable). Routes:

- `GET /health` — `200 { status: "ok", uptime: <seconds>, mcpConnected: true }` or `503 { status: "degraded" }` if MCP is disconnected
- `GET /metrics` — Prometheus exposition format via `prom-client`

**Structured logging**

Each module enriches pino log calls with:
- `component` field: `mcp | llm | agent | scheduler | slack | webhook`
- `correlationId` when present
- Log level driven by `LOG_LEVEL` env var (default `info`)

---

### 3. Correlation IDs

A `correlationId` (short UUID v4) is generated at the entry point of each logical request:

- Slack message handler: one per incoming message
- Scheduler: one per service per check tick

Passed as an explicit argument: `agent.run(prompt, { correlationId })` and through to `llm.chat()` and `mcp.executeTool()`. Logged at every layer. No global state or AsyncLocalStorage.

---

### 4. Config schema additions

New sections added to `config.yaml` / Zod schema:

```yaml
timeouts:
  mcpConnectMs: 30000       # default 30 000 ms
  llmCallMs: 60000          # default 60 000 ms
  toolExecutionMs: 30000    # default 30 000 ms
  agentIterationMs: 90000   # default 90 000 ms

retry:
  maxAttempts: 3
  baseDelayMs: 500

scheduler:
  anomalyCheck:
    alertCooldownMinutes: 30  # per-service dedup window

observability:
  port: 9090
  logLevel: info            # overridden by LOG_LEVEL env var
```

---

### 5. Structured anomaly detection

**Problem**: `isAnomaly()` in the scheduler matches keywords ("healthy", "no anomalies") against the agent's free-text response. Produces false positives on error responses. Severity is hardcoded `"medium"`.

**Solution**: Use OpenAI `response_format: { type: "json_schema" }` for proactive agent runs.

`LlmClient.chat()` gains an optional `responseFormat` parameter. When set, the API enforces the schema — no parsing failures possible.

The proactive system prompt instructs the agent to query all configured metrics and logs for the service, then return:

```ts
interface AnomalyAssessment {
  isAnomaly: boolean;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;            // 1-2 sentence human-readable description
  affectedMetrics: string[];  // which queries indicated the issue
  recommendedAction: string;  // what an engineer should look at first
}
```

The scheduler reads `isAnomaly` and `severity` directly. `summary` becomes the alert body. `recommendedAction` is added as a new field in the Slack Block Kit message.

**Alert deduplication**: `AlertDeduplicator` is a `Map<serviceName, lastAlertTimestamp>`. Before each notification, the scheduler checks whether `now - lastAlert < cooldownMinutes * 60_000`. If within cooldown, the notification is skipped and the `alert_notifications_total{status="deduplicated"}` counter is incremented.

---

## Files Changed

| File | Change |
|---|---|
| `src/utils/timeout.ts` | New |
| `src/utils/retry.ts` | New |
| `src/observability/metrics.ts` | New |
| `src/observability/server.ts` | New |
| `src/config/schema.ts` | Add timeouts, retry, observability sections |
| `src/mcp/client.ts` | Add timeout on connect + tool execution |
| `src/llm/openai.ts` | Add timeout, retry, responseFormat param, token tracking |
| `src/agent/core.ts` | Add correlationId param, per-iteration timeout, metrics |
| `src/agent/prompts.ts` | Add structured proactive prompt returning AnomalyAssessment |
| `src/agent/types.ts` | Add AnomalyAssessment type, RunOptions type |
| `src/scheduler/scheduler.ts` | Use structured output, add AlertDeduplicator, metrics |
| `src/notifications/slack-webhook.ts` | Add retry, add recommendedAction field |
| `src/interfaces/slack.ts` | Add correlationId generation, metrics |
| `src/index.ts` | Start observability server, pass config to all layers |
| `package.json` | Add prom-client dependency |

New test files mirror each new source file.

---

## Success Criteria

- No process hangs: every async call has a timeout
- Transient failures retry automatically (up to 3 attempts with backoff)
- Every agent run is traceable end-to-end via correlationId in logs
- `/health` returns 200 when healthy, 503 when MCP is disconnected
- `/metrics` returns valid Prometheus exposition format
- Anomaly alerts include severity (not hardcoded "medium"), summary, and recommended action
- Same service does not alert twice within the cooldown window
- All new code has unit tests

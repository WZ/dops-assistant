# Architecture

## Overview

dops-assistant is built as a layered dependency graph — each layer depends only on the layers below it. This makes components testable in isolation (mocking the layer below) and makes it straightforward to swap implementations (e.g. a different LLM provider) without touching the layers above.

There are two entry points into the system — the **Scheduler** (proactive) and the **Slack Bot** (interactive). Both delegate to the **Agent Core** for conversational queries and to the **InvestigationAgent** for autonomous root cause analysis. The **IntentClassifier** routes Slack messages to the appropriate path.

## Component map

```
dops-assistant
├── Observability Server (:9090)
│   ├── /health
│   └── /metrics (Prometheus)
│
├── Slack Bot (Socket Mode)
│   ├── IntentClassifier ──── "investigation" ──▶ InvestigationAgent
│   │                    └─── "question" ──────▶ Agent Core
│   └── Conversation Memory
│
├── Scheduler (cron)
│   ├── Agent Core (anomaly detection)
│   ├── InvestigationAgent (RCA on anomaly)
│   ├── Alert Deduplicator
│   └── Slack Webhook Notifier
│
├── InvestigationAgent (5-phase RCA pipeline)
│   ├── Phase 1: Anomaly detection (optional)
│   ├── Phase 2: Metric deep dive    ─┐
│   ├── Phase 3: Log correlation      ├─ parallel
│   ├── Phase 4: Infra health check  ─┘
│   └── Phase 5: RCA synthesis
│
├── Agent Core (agentic tool-call loop)
│   ├── LLM Client (OpenAI) ─── timeout + retry
│   └── MCP Client (Grafana) ── timeout + metrics
│
└── Grafana MCP Server (stdio or StreamableHTTP)
    ├── Prometheus
    ├── Loki
    ├── Dashboards
    └── Alerts
```

---

## Components

### Config

**Files:** `src/config/schema.ts`, `src/config/loader.ts`

A Zod schema validates the YAML config at startup. All `${ENV_VAR}` placeholders in the YAML are resolved against `process.env` before validation — if any referenced variable is missing, the process exits with a clear error.

The config is loaded once at startup in `src/index.ts` and passed down to each component that needs it. No component reads config independently.

Key config sections: `llm`, `grafana.mcpServer`, `services`, `scheduler.anomalyCheck`, `agent` (includes `investigationTriggerPhrases`), `notifications.slack`, `interfaces.slack`, `timeouts`, `retry`, `observability`.

---

### MCP Client

**File:** `src/mcp/client.ts`

Wraps `@modelcontextprotocol/sdk`. Supports two transport modes configured via `grafana.mcpServer.transport`:

- **`stdio`** — launches the Grafana MCP server as a child process
- **`http`** — connects to a remote Grafana MCP server via StreamableHTTP (e.g. a docker-compose sidecar)

At startup it calls `listTools` to discover available tools. If `enabledTools` is configured, only those tools are surfaced to the LLM. All tools are converted from MCP schema format to OpenAI function definition format.

`callTool(name, args)` executes a single tool call with a configurable timeout and returns the text content as a string. Application-level errors (`isError: true`) are prefixed with `[Tool Error]`. Transport-level failures throw exceptions. Prometheus metrics track tool call counts, durations, and timeouts.

---

### LLM Client

**File:** `src/llm/openai.ts`

A thin wrapper around the `openai` SDK. The single method `chat(messages, tools, opts?)` calls the chat completions API and returns a typed discriminated union:

- `{ type: "text", content: string }` — final response
- `{ type: "tool_calls", calls: ToolCall[] }` — the LLM wants to call tools

Supports `opts.responseFormat` for structured JSON output (used by the InvestigationAgent and proactive anomaly detection).

All calls go through `withTimeout` and `withRetry` wrappers. Prometheus counters track success, error, rate-limited, and timeout outcomes, plus token usage.

---

### Agent Core

**Files:** `src/agent/core.ts`, `src/agent/prompts.ts`, `src/agent/types.ts`

The agentic tool-call loop. `AgentCore.run(task)` accepts an `AgentTask` and returns an `AgentResult`:

```ts
type AgentTask = {
  mode: "proactive" | "conversational";
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
  correlationId?: string;
};
```

**The loop:**

1. Build messages: `[system prompt, ...history, user message]`
2. Call the LLM with messages and available tools
3. If `tool_calls` → execute all in parallel via `Promise.allSettled` → append results → go to 2
4. If `text` → return the response
5. If `maxIterations` reached → return a truncation message

**Proactive mode** uses structured output (`ResponseFormatJSONSchema`) to return an `AnomalyAssessment` with `isAnomaly`, `severity`, `summary`, `affectedMetrics`, and `recommendedAction`.

---

### InvestigationAgent

**Files:** `src/agent/investigation.ts`, `src/agent/rca-types.ts`, `src/agent/rca-prompts.ts`

A 5-phase autonomous root cause analysis pipeline:

1. **Anomaly detection** (optional) — runs the existing proactive prompt if no initial anomaly is provided
2. **Metric deep dive** — queries Prometheus for abnormal values, baselines, anomaly windows
3. **Log correlation** — queries Loki for error patterns, stack traces, first occurrence
4. **Infra health check** — checks pod restarts, node pressure, k8s events
5. **RCA synthesis** — combines all findings into a structured `RcaReport` with root cause, evidence, confidence, and recommended actions

Phases 2/3/4 run in parallel via `Promise.allSettled`. If any phase fails, the pipeline continues with empty findings for that phase (graceful degradation). Each phase uses its own `runPhase()` helper that runs a mini agentic loop with tools + structured JSON output.

The `RcaReport` output type:
```ts
type RcaReport = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  rootCause: string;
  evidence: { metrics: string[]; logs: string[]; infra: string[] };
  recommendedActions: string[];
  confidence: "low" | "medium" | "high";
  investigatedAt: string;
};
```

---

### IntentClassifier

**File:** `src/agent/intent.ts`

A single LLM call (no tools) that classifies a Slack message as either:

- `{ intent: "investigation", service?: string }` — route to InvestigationAgent
- `{ intent: "question" }` — route to Agent Core (conversational mode)

Uses structured JSON output. Falls back to `"question"` on any error (parse failure, LLM timeout, etc.).

---

### Conversation Memory

**File:** `src/memory/conversation.ts`

An in-memory `Map` keyed by Slack thread ID. Each entry holds a `Message[]` and a `lastActivity` timestamp.

- `append(threadId, message)` — adds a message and trims to `maxMessages`
- `get(threadId)` — returns the message array, or `[]` for unknown threads
- `destroy()` — stops the background eviction interval

A background `setInterval` evicts threads inactive beyond `ttlMinutes`. The interval is `.unref()`'d so it does not prevent process exit.

---

### Slack Webhook Notifier

**Files:** `src/notifications/slack-webhook.ts`, `src/notifications/rca-blocks.ts`

`sendAnomalyAlert(webhookUrl, alert)` formats an `AnomalyAlert` as Slack Block Kit blocks and POSTs to the webhook URL. If the alert includes an `rca` field (attached by the Scheduler after investigation), the standard alert blocks are replaced with rich RCA blocks showing root cause, evidence sections, recommended actions, confidence, and timestamp.

`formatRcaBlocks(report)` converts an `RcaReport` into `KnownBlock[]` with severity-emoji header, root cause section, evidence (metrics/logs/infra — empty sections omitted), numbered recommended actions, and a confidence/timestamp context footer.

---

### Scheduler

**File:** `src/scheduler/scheduler.ts`

Uses `node-cron` to run proactive anomaly checks on a configured interval.

On each tick:

1. Resolve services to check (all, or the subset in `scheduler.anomalyCheck.services`)
2. Split into chunks of `maxConcurrency`
3. For each service, run `agent.run()` in proactive mode with structured output
4. Parse the `AnomalyAssessment` JSON response
5. If `isAnomaly === true` and not suppressed by `AlertDeduplicator`:
   - Run `investigationAgent.investigate()` to get a full `RcaReport` (if investigation agent is available)
   - Attach the report to the alert and fire `sendAnomalyAlert`
6. If investigation fails, the alert is still sent without the RCA report

The `AlertDeduplicator` tracks the last alert time per service and suppresses alerts within the `alertCooldownMinutes` window.

---

### Slack Bot

**File:** `src/interfaces/slack.ts`

Uses `@slack/bolt` in Socket Mode. Registers `app.message` and `app.event("app_mention")` handlers.

Message routing:

1. If an `IntentClassifier` and `InvestigationAgent` are provided:
   - Classify the message intent
   - If `"investigation"` → find the matching service (or default to first) → run `investigationAgent.investigate()` → reply with RCA blocks
   - If `"question"` → fall through to conversational mode
2. Conversational mode: load history from memory → `agent.run()` → save response to memory → reply as text

If no classifier is configured, all messages go through conversational mode (backwards-compatible).

---

### Observability Server

**File:** `src/observability/server.ts`

An HTTP server on the configured port (default 9090) with two endpoints:

- `GET /health` — returns `{ status: "ok", mcpConnected: boolean }`
- `GET /metrics` — returns Prometheus-format metrics from the custom registry

**Prometheus metrics** (`src/observability/metrics.ts`):

| Metric | Type | Labels |
|--------|------|--------|
| `llm_calls_total` | Counter | `status` (success/error/timeout/rate_limited) |
| `llm_tokens_used_total` | Counter | `type` (prompt/completion) |
| `tool_calls_total` | Counter | `tool`, `status` |
| `tool_duration_seconds` | Histogram | `tool` |
| `scheduler_checks_total` | Counter | `service`, `status` |
| `alert_notifications_total` | Counter | `status` |
| `slack_messages_total` | Counter | `status` |

---

### Entry Point

**File:** `src/index.ts`

Wires all components together in dependency order:

1. Load config from `CONFIG_PATH` (default: `config.yaml`)
2. Start observability server (so `/health` is available during startup)
3. Connect MCP client (stdio or HTTP)
4. Construct LLM client, Agent Core, Conversation Memory
5. Construct InvestigationAgent and IntentClassifier
6. Start Scheduler with InvestigationAgent (if `scheduler.anomalyCheck` configured)
7. Start Slack Bot with IntentClassifier + InvestigationAgent (if `interfaces.slack.enabled`)
8. Register `SIGINT`/`SIGTERM` handlers for graceful shutdown

---

## Key design decisions

**Grafana MCP only** — A single MCP connection to Grafana covers Prometheus, Loki, dashboards, and alerts. No separate data source clients needed.

**Dual transport** — MCP supports both stdio (child process) and StreamableHTTP (docker-compose sidecar or remote deployment). Configured via `grafana.mcpServer.transport`.

**5-phase parallel RCA** — Phases 2/3/4 (metrics, logs, infra) run concurrently to minimize investigation time. Each phase is an independent agentic loop with its own structured output schema. Graceful degradation means a failed phase doesn't block the investigation.

**Intent-based routing** — A single lightweight LLM call classifies Slack messages before dispatching to the appropriate handler. This avoids running the full agentic loop for investigation requests that don't need conversational context.

**Structured output everywhere** — Proactive anomaly detection, per-phase investigation findings, and RCA synthesis all use OpenAI's `response_format: json_schema` for reliable parsing. No regex or string matching.

**Timeouts and retries** — All LLM calls and tool executions are wrapped with configurable timeouts and exponential backoff retries. Prometheus metrics track all outcomes.

**In-memory conversation store** — No database dependency for the MVP. Conversations are ephemeral with TTL-based eviction.

**Socket Mode Slack** — No public webhook URL required. Works behind firewalls.

**Promise.allSettled for parallelism** — Both the Agent Core (tool calls), Scheduler (service checks), and InvestigationAgent (phases 2/3/4) use `Promise.allSettled` so partial failures are isolated rather than aborting the whole batch.

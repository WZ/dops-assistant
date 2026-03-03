# Architecture

## Overview

dops-assistant is built as a layered dependency graph — each layer depends only on the layers below it. This makes components testable in isolation (mocking the layer below) and makes it straightforward to swap implementations (e.g. a different LLM provider) without touching the layers above.

The three entry points into the system — the Scheduler, Slack Bot, and CLI — all delegate to the Agent Core, which is the only component that knows about both the LLM and the MCP client. A separate Discovery Agent uses the same LLM + MCP stack to auto-discover services at startup or via the `npm run discover` CLI.

## Component map

```
Entry Point
├── Scheduler ──────────────────┐
├── Slack Bot ──────────────────┤
├── CLI ────────────────────────┤
│   └── Conversation Memory     │
│                               ▼
│                          Agent Core
│                          ├── LLM Client (OpenAI)
│                          └── MCP Client (Grafana)
├── Discovery Agent ───────────▶ LLM + MCP (auto-discovers services)
│   └── discover CLI (npm run discover)
└── Slack Webhook Notifier (used by Scheduler)
```

---

## Components

### Config

**Files:** `src/config/schema.ts`, `src/config/loader.ts`

A Zod schema validates the YAML config at startup. All `${ENV_VAR}` placeholders in the YAML are resolved against `process.env` before validation — if any referenced variable is missing, the process exits with a clear error.

The config is loaded once at startup in `src/index.ts` and passed down to each component that needs it. No component reads config independently.

---

### MCP Client

**File:** `src/mcp/client.ts`

Wraps `@modelcontextprotocol/sdk`. At startup it launches the Grafana MCP server as a stdio child process (the command is specified in `grafana.mcpServer` config), then calls `listTools` to discover available tools.

If `enabledTools` is configured, only those tools are surfaced to the LLM — the rest are filtered out. All tools are converted from MCP schema format to OpenAI function definition format so they can be passed directly to the LLM.

`callTool(name, args)` executes a single tool call and returns a `ToolResult` containing both text content and any image content (base64-encoded PNGs from tools like `get_panel_image`). If the MCP server signals an application-level error (`isError: true`), the text is prefixed with `[Tool Error]` so the LLM can reason about it. Transport-level failures (e.g. the child process dying) throw an exception, which the Agent Core catches and converts to a `[Transport Error]` tool result.

A single persistent connection is used for the lifetime of the process. TODO: add reconnection logic.

---

### LLM Client

**File:** `src/llm/openai.ts`

A thin wrapper around the `openai` SDK. The single method `chat(messages, tools)` calls the OpenAI chat completions API and returns a typed discriminated union:

- `{ type: "text", content: string }` — the LLM produced a final response
- `{ type: "tool_calls", calls: ToolCall[] }` — the LLM wants to call one or more tools

This shape is what the Agent Core loops on. The LLM client never loops itself — it makes exactly one API call per invocation.

Guards are in place for two failure modes: an empty `choices` array (content filtering) and malformed JSON in tool call arguments.

Setting `llm.baseURL` in config overrides the OpenAI endpoint, enabling use of OpenAI-compatible APIs (e.g. hosted open-source models).

---

### Agent Core

**Files:** `src/agent/core.ts`, `src/agent/prompts.ts`, `src/agent/types.ts`

The heart of the system. `AgentCore.run(task)` accepts an `AgentTask` and returns an `AgentResult`:

```ts
type AgentTask = {
  mode: "proactive" | "conversational";
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
};

type AgentResult = {
  response: string;
  updatedHistory: Message[];
};
```

**The agentic loop:**

1. Build the message array: `[system prompt, ...history, user message]`
2. Call the LLM with the current messages and available tools
3. If the response is `tool_calls` → execute all tool calls in parallel via `Promise.allSettled` → append the assistant message and tool results to the message array → go to step 2
4. If the response is `text` → append it as the assistant message → return
5. If `maxIterations` is reached → return a truncation message

Tool calls within a single LLM turn are executed in parallel. If some succeed and some fail, each gets its own result (success or `[Transport Error]`) — partial failures do not abort the batch.

Images returned by tool results (e.g. from `get_panel_image`) are collected as a side channel during the loop — decoded from base64 into `ImageAttachment` objects — and returned in `AgentResult.images`. The LLM receives a text hint (`[N chart image(s) captured]`) but the actual images are delivered to the user by the Slack Bot.

**System prompts:**

- **Proactive mode:** instructs the LLM to check each service's metrics and logs for anomalies, describe anything unusual with severity, and say "looks healthy" if all is well
- **Conversational mode:** instructs the LLM to act as an ops assistant, give specific metric values and timestamps, and link to dashboards when found

`updatedHistory` returns the full message array minus the system prompt, including intermediate tool-call messages. This is intentional — the Slack Bot stores this in conversation memory and passes it back on the next turn so the LLM has full context.

---

### Conversation Memory

**File:** `src/memory/conversation.ts`

An in-memory `Map` keyed by Slack thread ID. Each entry holds a `Message[]` and a `lastActivity` timestamp.

- `append(threadId, message)` — adds a message and trims to `maxMessages` (oldest removed)
- `get(threadId)` — returns the message array, or `[]` for unknown threads
- `clear(threadId)` — removes the thread entirely
- `destroy()` — stops the background eviction interval (called on shutdown)

A background `setInterval` (every 60 seconds) evicts threads inactive beyond `ttlMinutes`. The interval is `.unref()`'d so it does not prevent process exit.

---

### Slack Webhook Notifier

**File:** `src/notifications/slack-webhook.ts`

A single exported function `sendAnomalyAlert(webhookUrl, alert)`. Formats an anomaly as a Slack Block Kit message (header, service/severity fields, summary, optional metrics list, optional dashboard link button) and POSTs it to the webhook URL via `fetch`. Throws on non-2xx responses.

Used by the Scheduler — the Slack Bot does not use this; it replies directly in threads via the Bolt SDK.

---

### Scheduler

**File:** `src/scheduler/scheduler.ts`

Uses `node-cron` to run proactive anomaly checks on a configured interval. The interval string (`"5m"`, `"1h"`) is converted to a cron expression by `parseDurationToCron`.

On each tick, the scheduler:

1. Resolves the services to check (all services, or the subset listed in `scheduler.anomalyCheck.services`)
2. Splits them into chunks of `maxConcurrency`
3. For each chunk, runs `agent.run()` for every service in parallel via `Promise.allSettled`
4. For any response that does not contain "healthy" or "no anomalies" (case-insensitive), fires `sendAnomalyAlert`
5. Logs any rejected outcomes via pino (service check failures do not abort the batch)

**Anomaly detection heuristic:** The agent is prompted to say "everything looks healthy" when there are no issues. The scheduler treats any response lacking those keywords as an anomaly signal. This is intentionally simple — the LLM's judgment does the heavy lifting.

---

### Slack Bot

**File:** `src/interfaces/slack.ts`

Uses `@slack/bolt` in Socket Mode — no public URL required, works behind a firewall. Registers two handlers on startup:

- `app.message` — direct messages to the bot
- `app.event("app_mention")` — mentions in channels

Both handlers call `handleMessage(ctx, say)`, which:

1. Loads conversation history from `ConversationMemory` for the thread
2. Appends the user message to memory
3. Calls `agent.run()` in conversational mode with the loaded history
4. Appends the assistant response to memory
5. Posts the response to the thread via `say({ text, thread_ts })`
6. Uploads any collected images to the thread via `app.client.filesUploadV2` (failures are logged but non-fatal)

If `agent.run()` throws, the user receives "Sorry, something went wrong. Please try again." and the error is re-thrown for process-level logging. The user message remains in memory so context is not lost.

Thread ID is `event.thread_ts ?? event.ts` for mentions, and `message.ts` for DMs — this means each top-level message starts its own conversation context.

---

### CLI Interface

**Files:** `src/cli.tsx`, `src/interfaces/cli/App.tsx`

A terminal REPL built with Ink (React for CLIs). Started via `npm run cli`. Uses the same components as the Slack Bot — AgentCore, IntentClassifier, InvestigationAgent, ConversationMemory — but renders to the terminal instead of Slack.

Features:
- Real-time tool call log (via `onToolCall` callback on `AgentTask`)
- Spinner while the agent is thinking
- RCA reports displayed in bordered boxes
- Images saved to `/tmp` and opened automatically on macOS
- Conversation memory persists across turns within the session
- Special commands: `exit`/`quit`, `clear`

---

### Discovery Agent

**Files:** `src/agent/discovery.ts`, `src/agent/discovery-prompts.ts`

Automatically discovers services by querying Prometheus and Loki via the existing MCP connection. The agent uses a `consul_catalog_service_node_healthy` metric (configurable via `discovery.consulMetric`) to find registered services, then probes each one for RED metrics (rate, errors, duration) and Loki log labels.

The discovery loop follows the same pattern as the Agent Core — an LLM agentic loop with MCP tool calls — but uses a specialized system prompt and returns structured JSON via the OpenAI `json_schema` response format. The result is a `ServiceConfig[]` that can be merged with statically defined services.

Two triggers:

- **`npm run discover`** (`src/discover.tsx`) — an Ink-based CLI that runs discovery interactively, shows progress, and writes results back to the config file
- **Startup auto-refresh** — when `discovery.autoRefresh` is `true` in config, `src/index.ts` runs discovery at boot and merges new services into the runtime service list (does not write to disk)

Services listed in `discovery.excludeServices` (e.g. `consul`, `prometheus`, `grafana`) are filtered from results. Static services in config always take precedence — discovery only adds services not already defined.

---

### Entry Point

**Files:** `src/index.ts` (Slack + Scheduler), `src/cli.tsx` (CLI mode), `src/discover.tsx` (discovery CLI)

`src/index.ts` wires all components together in dependency order:

1. Load config from `CONFIG_PATH` (default: `config.yaml`)
2. Connect MCP client
3. Construct LLM client, Agent Core, Conversation Memory
4. Run service auto-discovery if `discovery.autoRefresh` is enabled (merges with static services)
5. Start Scheduler (if `scheduler.anomalyCheck` is configured)
6. Start Slack Bot (if `interfaces.slack.enabled` and tokens are present)
7. Register `SIGINT`/`SIGTERM` handlers for graceful shutdown

Graceful shutdown stops the Scheduler, stops the Slack Bot, destroys conversation memory (clears the eviction interval), and disconnects the MCP client.

`src/cli.tsx` is a separate entry point started via `npm run cli` (or `CONFIG_PATH=dev/config.yaml npm run cli`). It connects to MCP and the LLM but skips Slack, Scheduler, and ObservabilityServer. On exit, it disconnects MCP and destroys conversation memory.

`src/discover.tsx` is started via `npm run discover`. It connects to MCP, runs the Discovery Agent, merges results with static config, writes back to the config file, and exits.

---

## Key design decisions

**Grafana MCP only** — A single MCP connection to Grafana covers Prometheus, Loki, dashboards, and alerts. No separate Prometheus MCP is needed.

**OpenAI for MVP** — Single LLM provider to keep the implementation simple. The `LlmClient` interface is thin enough that adding a second provider would be a contained change.

**In-memory conversation store** — No database dependency for the MVP. Conversations are ephemeral with TTL-based eviction. Persistent storage (SQLite/Postgres) is a future enhancement.

**Socket Mode Slack** — No public webhook URL required. Simpler deployment and works in private networks.

**Promise.allSettled for parallelism** — Both the Agent Core (tool call execution) and the Scheduler (service checks) use `Promise.allSettled` so partial failures are isolated and reported individually rather than aborting the whole batch.

**Anomaly detection via LLM judgment** — Rather than defining thresholds in config, the proactive system prompt describes what to look for and the LLM decides. This handles novel anomalies and cross-metric patterns that rule-based systems miss, at the cost of occasional false positives.

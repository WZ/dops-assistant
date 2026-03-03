# MVP Components Design

## Context

Config layer is complete (`src/config/schema.ts`, `src/config/loader.ts`). This doc covers the design for all remaining components.

## Build Order

Bottom-up by dependency: MCP client → LLM client → Agent core → Conversation memory → Slack webhook notifier → Scheduler → Slack bot → Entry point.

## Test Stack

Vitest alongside each component. Mock dependencies at layer boundaries.

---

## Layer 1 — MCP Client (`src/mcp/client.ts`)

Wraps `@modelcontextprotocol/sdk`. At startup: launches the Grafana MCP server as a stdio child process, calls `listTools`, filters by `enabledTools` if configured, converts MCP tool schemas to OpenAI function definitions.

**API:**
- `connect()` — launches child process, discovers tools
- `getTools()` → OpenAI-compatible tool definitions array
- `callTool(name, args)` → result string
- `disconnect()` — terminates child process

Single persistent connection. `// TODO: add reconnection logic for future enhancement` at connection site.

**Tests:** mock MCP SDK transport, assert tool filtering, assert tool call result returned correctly.

---

## Layer 2 — LLM Client (`src/llm/openai.ts`)

Thin wrapper around the `openai` SDK. No streaming for MVP.

**API:**
- `chat(messages, tools)` → `{ type: "text", content: string } | { type: "tool_calls", calls: ToolCall[] }`

Reads `apiKey`, `model`, `maxTokens`, `baseURL` from config at construction.

**Tests:** mock OpenAI SDK, assert correct response shape for text and tool call responses.

---

## Layer 3 — Agent Core (`src/agent/core.ts`, `prompts.ts`, `types.ts`)

**Input:** `AgentTask { mode: "proactive" | "conversational", message: string, serviceContext?: ServiceConfig[], history?: Message[] }`

**Loop:**
1. Build system prompt from mode + service context
2. Call LLM with current messages + tools
3. If tool calls → execute via MCP client → append results → repeat
4. If text response → return it
5. If `maxIterations` reached → return truncation message

**Output:** `{ response: string, updatedHistory: Message[] }`

**System prompts:**
- Proactive: anomaly detection instructions + service metrics/thresholds
- Conversational: ops assistant persona, instructed to reference specific data and dashboard links

**Tests:** mock LLM client and MCP client, assert loop terminates on text, assert tool calls executed and fed back, assert maxIterations guard.

---

## Layer 4 — Conversation Memory (`src/memory/conversation.ts`)

In-memory `Map<threadId, { messages: Message[], lastActivity: Date }>`.

**API:**
- `get(threadId)` → `Message[]` (empty array if unknown)
- `append(threadId, message)` → void (trims to `maxMessages`)
- `clear(threadId)` → void

Background `setInterval` (every minute) evicts threads inactive beyond `ttlMinutes`.

**Tests:** assert trim at maxMessages, assert TTL eviction, assert empty array for unknown threads.

---

## Layer 5 — Slack Webhook Notifier (`src/notifications/slack-webhook.ts`)

**API:**
- `sendAnomalyAlert(webhookUrl, alert)` — POSTs a Block Kit message via `fetch`

Alert shape: `{ service: string, severity: "low" | "medium" | "high", summary: string, metrics?: string[], dashboardUrl?: string }`

Throws on non-2xx response.

**Tests:** mock `fetch`, assert payload shape, assert throw on error response.

---

## Layer 6 — Scheduler (`src/scheduler/scheduler.ts`)

Takes config + agent core + notifier at construction. Converts duration string (`"5m"`) to cron expression (`"*/5 * * * *"`) internally.

**API:**
- `start()` — sets up node-cron job
- `stop()` — destroys cron job

On each tick: resolves services to check, runs agent tasks in parallel with concurrency cap via `Promise.allSettled`. Calls notifier if agent response signals anomalies.

**Tests:** mock agent core and notifier, assert concurrency respected, assert notifier called on anomaly, assert stop prevents further ticks.

---

## Layer 7 — Slack Bot (`src/interfaces/slack.ts`)

Uses `@slack/bolt` in Socket Mode. Listens for `app_mention` and DMs.

**On message:**
1. Extract thread ID (fallback to message `ts`)
2. Load history from conversation memory
3. Call agent core (conversational mode) with history
4. Append user message + response to memory
5. Post response back to thread

**API:**
- `start()` — initializes Bolt App, starts Socket Mode
- `stop()` — stops Bolt App

**Tests:** mock Bolt App, agent core, conversation memory; assert history loaded/passed correctly, assert response posted to correct thread.

---

## Layer 8 — Entry Point (`src/index.ts`)

Pure wiring. No tests.

1. `loadConfig(configPath)`
2. Initialize pino logger
3. `McpClient.connect()`
4. Construct `LlmClient`, `AgentCore`, `ConversationMemory`, `SlackWebhookNotifier`
5. If `scheduler.anomalyCheck` configured → `scheduler.start()`
6. If `interfaces.slack.enabled` → `slackBot.start()`
7. `SIGINT`/`SIGTERM` handlers → `scheduler.stop()`, `slackBot.stop()`, `mcpClient.disconnect()`

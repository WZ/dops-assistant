# Architecture

## Overview

dops-assistant is built as a layered dependency graph — each layer depends only on the layers below it. This makes components testable in isolation (mocking the layer below) and makes it straightforward to swap implementations (e.g. a different LLM provider) without touching the layers above.

The CLI classifies user input via the IntentClassifier, then delegates to **ChatAgent** (conversational questions) or **InvestigationAgent** (structured RCA). A separate **DiscoveryAgent** uses the same LLM + MCP stack to auto-discover services at startup or via `npm run discover`.

## Component map

```
Entry Point
├── CLI ────────────────────────┐
│   ├── Conversation Memory     │
│   └── IntentClassifier        │
│        ├── question ──────────▼
│        │                 ChatAgent
│        └── investigate ──▶ InvestigationAgent (5-phase RCA)
│                          ├── LLM Client (OpenAI)
│                          └── MCP Client (Grafana)
└── DiscoveryAgent ────────────▶ LLM + MCP (auto-discovers services)
    └── discover CLI (npm run discover)
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

`callTool(name, args)` executes a single tool call and returns a `ToolResult` containing both text content and any image content (base64-encoded PNGs from tools like `get_panel_image`). If the MCP server signals an application-level error (`isError: true`), the text is prefixed with `[Tool Error]` so the LLM can reason about it. Transport-level failures (e.g. the child process dying) throw an exception, which the ChatAgent catches and converts to a `[Transport Error]` tool result.

A single persistent connection is used for the lifetime of the process. TODO: add reconnection logic.

---

### LLM Client

**File:** `src/llm/openai.ts`

A thin wrapper around the `openai` SDK. The single method `chat(messages, tools)` calls the OpenAI chat completions API and returns a typed discriminated union:

- `{ type: "text", content: string }` — the LLM produced a final response
- `{ type: "tool_calls", calls: ToolCall[] }` — the LLM wants to call one or more tools

This shape is what the ChatAgent loops on. The LLM client never loops itself — it makes exactly one API call per invocation.

Guards are in place for two failure modes: an empty `choices` array (content filtering) and malformed JSON in tool call arguments.

Setting `llm.baseURL` in config overrides the OpenAI endpoint, enabling use of OpenAI-compatible APIs (e.g. hosted open-source models).

---

### ChatAgent

**Files:** `src/agent/core.ts`, `src/agent/prompts.ts`, `src/agent/types.ts`

The conversational agent. `ChatAgent.chat(request)` accepts a `ChatRequest` and returns a `ChatResponse`:

```ts
type ChatRequest = {
  mode: "proactive" | "conversational";
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
};

type ChatResponse = {
  response: string;
  updatedHistory: Message[];
  images: ImageAttachment[];
};
```

**The agentic loop:**

1. Build the message array: `[system prompt, ...history, user message]`
2. Call the LLM with the current messages and available tools
3. If the response is `tool_calls` → execute all tool calls in parallel via `Promise.allSettled` → append the assistant message and tool results to the message array → go to step 2
4. If the response is `text` → append it as the assistant message → return
5. If `maxIterations` is reached → return a truncation message

Tool calls within a single LLM turn are executed in parallel. If some succeed and some fail, each gets its own result (success or `[Transport Error]`) — partial failures do not abort the batch.

Images returned by tool results (e.g. from `get_panel_image`) are collected as a side channel during the loop — decoded from base64 into `ImageAttachment` objects — and returned in `ChatResponse.images`. The LLM receives a text hint (`[N chart image(s) captured]`) but the actual images are delivered to the user by the CLI (saved to `/tmp` and opened).

**System prompts:**

- **Proactive mode:** instructs the LLM to check each service's metrics and logs for anomalies, describe anything unusual with severity, and say "looks healthy" if all is well
- **Conversational mode:** instructs the LLM to act as an ops assistant, give specific metric values and timestamps, and link to dashboards when found

`updatedHistory` returns the full message array minus the system prompt, including intermediate tool-call messages. This is intentional — the CLI stores this in conversation memory and passes it back on the next turn so the LLM has full context.

---

### Conversation Memory

**File:** `src/memory/conversation.ts`

An in-memory `Map` keyed by conversation ID. Each entry holds a `Message[]` and a `lastActivity` timestamp.

- `append(id, message)` — adds a message and trims to `maxMessages` (oldest removed)
- `get(id)` — returns the message array, or `[]` for unknown conversations
- `clear(id)` — removes the conversation entirely
- `destroy()` — stops the background eviction interval (called on shutdown)

A background `setInterval` (every 60 seconds) evicts conversations inactive beyond `ttlMinutes`. The interval is `.unref()`'d so it does not prevent process exit.

---

### CLI Interface

**Files:** `src/cli.tsx`, `src/interfaces/cli/App.tsx`

A terminal REPL built with Ink (React for CLIs). Started via `npm run cli`. Uses ChatAgent, IntentClassifier, InvestigationAgent, and ConversationMemory, rendering interactively to the terminal.

Features:
- Real-time tool call log (via `onToolCall` callback on `ChatRequest`)
- Spinner while the agent is thinking
- RCA reports displayed in bordered boxes
- Images saved to `/tmp` and opened automatically on macOS
- Conversation memory persists across turns within the session
- Special commands: `exit`/`quit`, `clear`

---

### Discovery Agent

**Files:** `src/agent/discovery.ts`, `src/agent/discovery-prompts.ts`

Automatically discovers services by querying Prometheus and Loki via the existing MCP connection. The agent uses a `consul_catalog_service_node_healthy` metric (configurable via `discovery.consulMetric`) to find registered services, then probes each one for RED metrics (rate, errors, duration) and Loki log labels.

The discovery loop follows the same pattern as the ChatAgent — an LLM agentic loop with MCP tool calls — but uses a specialized system prompt and returns structured JSON via the OpenAI `json_schema` response format. The result is a `ServiceConfig[]` that can be merged with statically defined services.

Two triggers:

- **`npm run discover`** (`src/discover.tsx`) — an Ink-based CLI that runs discovery interactively, shows progress, and writes results back to the config file
- **Startup auto-refresh** — when `discovery.autoRefresh` is `true` in config, `src/index.ts` runs discovery at boot and merges new services into the runtime service list (does not write to disk)

Services listed in `discovery.excludeServices` (e.g. `consul`, `prometheus`, `grafana`) are filtered from results. Static services in config always take precedence — discovery only adds services not already defined.

---

### Entry Point

**Files:** `src/cli.tsx` (CLI mode), `src/discover.tsx` (discovery CLI)

`src/cli.tsx` is the main entry point, started via `npm run cli`. It wires all components together:

1. Load config from `CONFIG_PATH` (default: `dev/config.yaml`)
2. Connect MCP client
3. Construct LLM client, ChatAgent, Investigation Agent, Intent Classifier, Conversation Memory
4. Render the Ink terminal UI

On exit, it disconnects MCP and destroys conversation memory.

`src/discover.tsx` is started via `npm run discover`. It connects to MCP, runs the Discovery Agent, merges results with static config, writes back to the config file, and exits.

---

## Key design decisions

**Grafana MCP only** — A single MCP connection to Grafana covers Prometheus, Loki, dashboards, and alerts. No separate Prometheus MCP is needed.

**OpenAI for MVP** — Single LLM provider to keep the implementation simple. The `LlmClient` interface is thin enough that adding a second provider would be a contained change.

**In-memory conversation store** — No database dependency for the MVP. Conversations are ephemeral with TTL-based eviction. Persistent storage (SQLite/Postgres) is a future enhancement.

**Promise.allSettled for parallelism** — The ChatAgent uses `Promise.allSettled` for parallel tool call execution so partial failures are isolated and reported individually rather than aborting the whole batch.

**Anomaly detection via LLM judgment** — Rather than defining thresholds in config, the proactive system prompt describes what to look for and the LLM decides. This handles novel anomalies and cross-metric patterns that rule-based systems miss, at the cost of occasional false positives.

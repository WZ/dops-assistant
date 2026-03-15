# Architecture

## Overview

dops-assistant is an AI-powered DevOps assistant that connects to monitoring infrastructure via MCP (Model Context Protocol) for conversational queries and automated root cause analysis.

It has two interfaces — a web UI (port 3000) and a terminal CLI — both backed by Mastra agents and workflows. User messages are classified by an intent router: questions go to a chat agent, incident reports trigger a 6-phase investigation workflow with parallel evidence gathering.

![System Overview](img/system-overview.svg)

---

## Interfaces

**Web UI** (`src/server/`) — Express server with WebSocket transport. Serves a React frontend from `dist/web/`. Chat messages and investigation progress stream in real-time via WebSocket events (`chat:stream_delta`, `investigation:phase`, `investigation:tool_call`).

**CLI** (`src/cli/`) — Terminal REPL built with Ink (React for CLIs). Same agent and workflow stack as the web server, rendered in the terminal with tool call logging, markdown rendering, and RCA reports in bordered boxes.

Both interfaces share the same agent layer through duck-typed interfaces (`IChatAgent`, `IInvestigationAgent`) defined in `src/types/agent-interfaces.ts`. The server adapter (`src/server/agents.ts`) wraps Mastra agents into these interfaces.

---

## Intent Routing

The `IntentRouter` (`src/agents/intent.ts`) classifies every user message before it reaches an agent.

**Fast-paths** (no LLM call — handles ~80% of messages):
- Strong keywords: "investigate", "diagnose", "rca", "troubleshoot" → investigation
- Display requests: "show me", "display" (without symptoms) → question
- Informational: "how is", "tell me about" (without symptoms) → question
- Symptom + service: "kafka is slow", "ingestion rate dropped" → investigation

**LLM fallback**: Ambiguous messages are classified by a `generateText` call with a few-shot prompt.

**Service matching**: `matchServiceFromText`, `validateLlmServiceMatch`, and `resolveServiceFromHistory` resolve which configured service the user is referring to, using token overlap, alias resolution (e.g., "kafka" → "kafka-brokers"), and conversation history scanning.

---

## Chat Agent

The `ChatAgent` (`src/agents/chat.ts`) is a Mastra Agent with access to all MCP tools. It handles conversational queries — "show me CPU usage", "what dashboards do we have?", "query error rate for the last hour".

**Streaming**: The server adapter translates Mastra stream events (`text-delta`, `tool-call`, `tool-result`) into WebSocket messages. Tool calls are visible in the UI as they happen. Metric query results are parsed by `extractChartSeries()` in `ws-handler.ts` for inline chart rendering.

---

## Investigation Workflow

The investigation workflow (`src/workflows/investigation.ts`) is a 6-phase Mastra workflow that performs automated root cause analysis. It is the core of the system.

![Investigation Flow](img/investigation-flow.svg)

### Phase 1: Prefetch Context

**File**: `src/workflows/steps/prefetch.ts`

Before any agent runs, the prefetch step discovers the monitoring environment:
- Datasource UIDs (which metric and log backends are available)
- Dashboard list with panel queries (scored by relevance to the user's message)
- Working log selectors (probes candidate selectors to find ones that return real data)

This is critical — without prefetching, agents waste iterations calling discovery tools instead of investigating.

### Phase 2: Anomaly Detection

**File**: `src/workflows/steps/anomaly.ts`

Two modes:
- **User-reported** (most common): The user described the problem ("ingestion rate dropped"). Skip the anomaly agent, extract the time range, and pass through.
- **Proactive**: No specific issue reported. Run the anomaly detector agent with metric tools to scan for anomalies.

### Phase 3: Planning

**File**: `src/workflows/steps/planning.ts`

Generates investigation hypotheses. Fetches recent incidents from the local history store (`src/workflows/history.ts`) to provide context — if the same service had a similar issue last week, the planner considers whether it's a recurrence.

Output: focus areas for each evidence agent (which metrics to check, which log patterns to look for, which infrastructure components to verify).

### Phase 4: Parallel Evidence Gathering

**File**: `src/workflows/steps/evidence.ts`

Three agents run concurrently, each with a focused tool subset:

| Agent | Role | Tools | Output |
|-------|------|-------|--------|
| **Metrics** | Deep-dive metric analysis | Metric query tools | Anomalous values, baselines, timestamps |
| **Logs** | Log pattern correlation | Log query, stats, pattern tools | Error patterns, counts, sample lines |
| **Infra** | Infrastructure health | Metric query, alert rule tools | Resource status, pod restarts, OOM events |

All three use a shared `buildEvidenceStep()` abstraction that handles the common pattern: get tools by role → filter by allowlist → wrap with callbacks → run agent → extract JSON → return findings with graceful fallback.

Each agent gets only the tools relevant to its role. This is essential — providing all 50+ tools causes the LLM to skip tool use entirely or call irrelevant discovery tools.

### Phase 5: Synthesis

**File**: `src/workflows/steps/synthesis.ts`

Combines all evidence into a structured RCA report:
1. Build a chronological timeline from metric, log, and infra observations
2. Run the synthesis agent to produce root cause, trigger, contributing factors, and recommendations
3. **Deterministic severity validation** — `validateSeverity()` overrides the LLM's severity when evidence contradicts it (e.g., "no anomaly found" but severity is "critical" → corrected to "low")

### Phase 6: Post-Synthesis

**File**: `src/workflows/steps/post-synthesis.ts`

Saves the incident to the local history store so future investigations can reference it. The planning step (Phase 3) reads this history to detect recurring patterns.

### Supporting Modules

| File | Purpose |
|------|---------|
| `tool-utils.ts` | Tool wrapping with callbacks, argument coercion (fixes LLM type mismatches), selection by suffix allowlist |
| `schemas.ts` | Zod schemas for all step inputs/outputs |
| `helpers.ts` | Timeline building, severity validation, time range parsing |
| `history.ts` | Filesystem-based incident history (read/write JSON to `.dops/`) |

---

## MCP Providers

**File**: `src/mcp/provider.ts`

MCP integration via `@mastra/mcp`. The system is MCP-agnostic — any MCP-compatible server can be plugged in via configuration.

Each provider declares **roles** (`metrics`, `logs`, `dependencies`) and tools are filtered per-agent by role. This prevents the LLM from being overwhelmed with irrelevant tools and ensures each agent has a focused, manageable tool set.

Multiple providers can be configured simultaneously. Tools are namespaced by provider to avoid collisions.

```yaml
providers:
  - name: grafana
    roles: [metrics, logs]
    mcpServer:
      transport: stdio
      command: "npx"
      args: ["-y", "@grafana/mcp-grafana"]
  - name: datadog
    roles: [metrics]
    mcpServer:
      transport: http
      url: "http://localhost:8080"
```

---

## Specialized Agents

**Directory**: `src/agents/`

Seven Mastra agents, each with a focused system prompt and tool subset:

| Agent | File | Tools | Purpose |
|-------|------|-------|---------|
| Chat | `chat.ts` | All (filtered) | Conversational queries |
| Anomaly Detector | `anomaly-detector.ts` | Metric queries | Detect anomalies |
| Planner | `planner.ts` | None | Generate hypotheses |
| Metrics | `metrics.ts` | Metric queries, histograms | Deep-dive metrics |
| Logs | `logs.ts` | Log queries, stats, patterns | Log correlation |
| Infra | `infra.ts` | Metric queries, alert rules | Infrastructure health |
| Synthesis | `synthesis.ts` | None | Combine evidence into RCA |

**Shared utilities** (`agents/shared/`):
- `prepare-step.ts` — LLM quirk handling (hallucinated tool calls, wind-down forcing). Removable when switching to a model without these issues.
- `processors.ts` — `safeJsonParse()` extracts JSON from LLM output that may be wrapped in markdown, prose, or code blocks.
- `time-context.ts` — Injects current time and timezone into prompts so the LLM can convert relative times ("yesterday") to absolute timestamps for queries.

---

## Key Design Decisions

**MCP-agnostic tool integration** — The system connects to any MCP-compatible server. Tool routing is role-based, not provider-specific. Adding a new monitoring backend means adding a provider config block, not changing code.

**Role-based tool filtering** — Each agent gets only the tools relevant to its job. Providing all tools causes the LLM to skip tool use or call irrelevant tools. The allowlist is defined in `tool-utils.ts`.

**Parallel evidence gathering** — Metrics, logs, and infra agents run concurrently via Mastra's `.parallel()`. This cuts investigation time by ~3x compared to sequential execution.

**Regex fast-paths for intent routing** — Most messages are classified without an LLM call. Only genuinely ambiguous messages hit the model.

**Graceful degradation** — Every workflow step catches errors and returns empty/default findings. A failed log agent doesn't crash the investigation — the synthesis step works with whatever evidence is available.

**Deterministic severity validation** — The LLM's severity judgment is validated against the evidence. If the evidence shows no anomaly, severity is corrected to "low" regardless of what the LLM said.

**Incident history** — Past investigations are saved to disk and injected into the planning step. This gives the agent memory across sessions — "this service had the same issue 3 days ago, the root cause was X."

**Duck-typed adapter pattern** — The server and CLI don't depend on Mastra directly. They call `agent.chat()` and `investigationAgent.investigate()` through interfaces (`IChatAgent`, `IInvestigationAgent`). The adapter layer translates.

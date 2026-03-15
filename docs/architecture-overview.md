# Architecture

## Overview

dops-assistant is an AI-powered DevOps assistant that integrates with Grafana via MCP (Model Context Protocol) for monitoring, alerting, and root cause analysis.

It has two interfaces — a web UI (port 3000) and a terminal CLI — both backed by Mastra agents and workflows. User messages are classified by an intent router: questions go to a chat agent, incident reports trigger a multi-phase investigation workflow.

## Component map

```
User Message
├── Web UI (port 3000) ──► WebSocket ──┐
│                                       ▼
└── CLI (Ink terminal) ──────────► IntentRouter
                                       │
                        ┌──────────────┼──────────────┐
                        ▼              ▼              ▼
                   question      investigation    (service matching)
                        │              │
                        ▼              ▼
                   ChatAgent    InvestigationWorkflow
                   (Mastra)     (6-phase Mastra workflow)
                        │              │
                        └──────┬───────┘
                               ▼
                         MCP Providers
                        (Grafana tools)
```

---

## Key modules

### Intent Router (`src/agents/intent.ts`)

Classifies user messages as "investigation" or "question" using regex fast-paths (no LLM call for obvious keywords like "investigate", "diagnose", symptom + service combos) with an LLM fallback via AI SDK `generateText` for ambiguous messages. Also provides service name matching/resolution from free text and conversation history.

### Chat Agent (`src/agents/chat.ts`)

A Mastra Agent with access to MCP tools (Prometheus, Loki, dashboards). Handles conversational queries — "show me CPU usage", "what dashboards do we have?". Streams responses via WebSocket with tool call visibility.

### Investigation Workflow (`src/workflows/investigation.ts`)

A 6-phase Mastra workflow for root cause analysis:

```
prefetch → anomaly → planning → [metrics ‖ logs ‖ infra] → synthesis → post-synthesis
```

1. **Prefetch** (`steps/prefetch.ts`) — Discover datasource UIDs, dashboards, and Loki log selectors
2. **Anomaly** (`steps/anomaly.ts`) — Detect anomalies or pass through user-reported issues
3. **Planning** (`steps/planning.ts`) — Generate investigation hypotheses using incident history
4. **Evidence** (`steps/evidence.ts`) — Three parallel agents gather metrics, logs, and infrastructure evidence. Uses a shared `buildEvidenceStep` abstraction to eliminate duplication.
5. **Synthesis** (`steps/synthesis.ts`) — Combine evidence into an RCA report with deterministic severity validation
6. **Post-synthesis** (`steps/post-synthesis.ts`) — Save incident to history for future context

Supporting modules:
- `tool-utils.ts` — Tool wrapping, argument coercion, selection by role
- `schemas.ts` — Zod schemas for step I/O
- `helpers.ts` — Timeline building, severity validation, time range parsing
- `history.ts` — Incident history store (filesystem-based)

### Specialized Agents (`src/agents/`)

Seven Mastra agents, each with a focused system prompt and tool subset:

| Agent | Tools | Purpose |
|-------|-------|---------|
| `chat.ts` | All (minus panel images) | Conversational queries |
| `anomaly-detector.ts` | query_prometheus | Detect anomalies from metrics |
| `planner.ts` | None | Generate investigation hypotheses |
| `metrics.ts` | query_prometheus, histograms | Deep-dive metric analysis |
| `logs.ts` | query_loki_logs, patterns, stats | Log correlation |
| `infra.ts` | query_prometheus, alerts | Infrastructure health |
| `synthesis.ts` | None | Combine evidence into RCA report |

Shared utilities in `agents/shared/`:
- `prepare-step.ts` — LLM quirk handling (removable when switching models)
- `processors.ts` — `safeJsonParse` for extracting JSON from LLM output
- `time-context.ts` — Current time/timezone for prompt context

### MCP Provider (`src/mcp/provider.ts`)

Role-based MCP integration via `@mastra/mcp`. Each provider declares roles (`metrics`, `logs`, `dependencies`) and tools are filtered per-agent by role, preventing the LLM from being overwhelmed with irrelevant tools.

### Server Adapter (`src/server/agents.ts`)

Wraps Mastra agents/workflows into duck-typed interfaces (`IChatAgent`, `IInvestigationAgent`) that the WebSocket handler and CLI call. Handles streaming translation between Mastra events and the WebSocket protocol.

### WebSocket Handler (`src/server/ws-handler.ts`)

Routes WebSocket messages to chat or investigation flows. Manages phase progress tracking, tool call events, and chart data extraction from Prometheus query results for inline rendering.

### CLI (`src/cli/`)

Terminal REPL built with Ink (React for CLIs). Entry point: `index.tsx`. Components: `App.tsx` (main app), `Markdown.tsx` (terminal markdown rendering), `CliTextInput.tsx` (input with history).

---

## Data flow

### Chat flow
```
User message → IntentRouter (question) → ChatAgent.chat()
  → Mastra agent.stream() → text-delta/tool-call/tool-result events
  → WebSocket: chat:stream_delta, chat:tool_call, chat:stream_end
  → If Prometheus results: extractChartSeries() → inline charts
```

### Investigation flow
```
User message → IntentRouter (investigation) → InvestigationAdapter.investigate()
  → createInvestigationWorkflow() → run.start(inputData)
  → Each phase emits: onPhase, onIteration, onToolCall callbacks
  → WebSocket: investigation:phase, investigation:iteration, investigation:tool_call
  → Synthesis produces RcaReport → investigation:complete
  → Post-synthesis saves to incident history
```

---

## Key design decisions

**Mastra for agent orchestration** — Provides structured workflows with parallel step execution, agent abstraction with tool integration, and a clean separation between agent logic and infrastructure.

**Role-based tool filtering** — Each agent gets only the tools it needs. Providing all 50+ Grafana tools causes the LLM to skip tool use or call irrelevant tools.

**Regex fast-paths for intent routing** — Most messages are classified without an LLM call. Only ambiguous messages hit the model.

**Graceful degradation** — Every workflow step catches errors and returns empty/default findings rather than crashing. Partial results are better than no results.

**Deterministic severity validation** — The synthesis step's severity is validated by `validateSeverity()` which overrides the LLM's judgment when evidence contradicts it (e.g., "no anomaly found" with severity "critical").

**Incident history for context** — Past investigations are stored locally and injected into the planning step so the agent can recognize recurring patterns.

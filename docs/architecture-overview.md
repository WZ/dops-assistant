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

**Directory**: `src/workflows/steps/prefetch/`, `src/workflows/steps/prefetch-step.ts`

Before any agent runs, the prefetch step runs three parallel tracks:
1. **Monitoring environment discovery** — datasource UIDs, dashboard list with scored panel queries, working log selectors (probes candidate selectors to find ones that return real data). Provider-agnostic — `index.ts` dispatches to `grafana.ts` or `generic.ts`.
2. **Coroot neighbor discovery** (optional, when a `dependencies`-role provider is configured) — `src/server/coroot.ts:fetchCorootNeighbors()` calls the Coroot MCP `get_application` tool and parses 1-hop upstream callers + downstream callees, with worst-wins severity dedup for bidirectional neighbors.
3. **Per-neighbor evidence fetch** (when neighbors are discovered) — `src/server/neighbor-evidence.ts` ranks unhealthy/degraded/unknown neighbors by severity then request rate, filters to the top 3 that are registered in `services.yaml`, and issues deterministic PromQL + LogQL queries via the existing `metrics` and `logs` role MCP tools. The result is a `NeighborEvidence` structure attached to each neighbor.

Neighbors and their evidence flow through every downstream step via the same schema pass-through pattern the existing `timeRange` field uses — `PrefetchedContextSchema.neighbors` → `AnomalyOutputSchema.prefetchContext.neighbors` → evidence factory injection → synthesis.

This is critical — without prefetching, agents waste iterations calling discovery tools instead of investigating, and without neighbor evidence the RCA report stops at "probably Kafka" instead of showing actual Kafka broker metrics.

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

Up to four agents run concurrently, each with a focused tool subset:

| Agent | Role | Tools | Output |
|-------|------|-------|--------|
| **Metrics** | Deep-dive metric analysis | Metric query tools | Anomalous values, baselines, timestamps |
| **Logs** | Log pattern correlation | Log query, stats, pattern tools | Error patterns, counts, sample lines |
| **Infra** | Infrastructure health | Metric + K8s tools | Resource status, pod restarts, OOM events |
| **Changes** | Change correlation | GitLab/deployment tools | Recent deployments, MRs, pipeline status |

All four use a shared `buildEvidenceStep()` abstraction that handles the common pattern: get tools by role → filter by allowlist → wrap with callbacks → run agent → extract JSON → return findings with graceful fallback.

Each agent gets only the tools relevant to its role. This is essential — providing all 50+ tools causes the LLM to skip tool use entirely or call irrelevant discovery tools. The changes agent only runs when a provider with the `"changes"` role is configured.

### Phase 5: Synthesis

**File**: `src/workflows/steps/synthesis.ts`

Combines all evidence into a structured RCA report:
1. Build a chronological timeline from metric, log, and infra observations
2. **Dependency Evidence section** — when prefetch has gathered neighbor evidence, synthesis inserts a `wrapUntrusted("dependency_evidence", ...)` block into the LLM prompt showing each neighbor's metric and log samples, so the synthesis agent can cite it in `rootCause`, `contributingFactors`, or `timeline`.
3. Run the synthesis agent to produce root cause, trigger, contributing factors, and recommendations
4. **Deterministic severity validation** — `validateSeverity()` overrides the LLM's severity when evidence contradicts it (e.g., "no anomaly found" but severity is "critical" → corrected to "low")
5. **Deterministic neighbor-evidence injection** — after the LLM call, host code appends each neighbor's metric and log samples to `evidence.metrics` / `evidence.logs` as `[neighbor:X]` formatted strings. The LLM writes the narrative; host code writes the structured evidence. This is what makes the "Dependency Evidence" story deterministic end-to-end — the report shows neighbor data whether or not the LLM cited it.

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

Each provider declares **roles** (`metrics`, `logs`, `dashboards`, `dependencies`, `infrastructure`, `changes`) and tools are filtered per-agent by role. This prevents the LLM from being overwhelmed with irrelevant tools and ensures each agent has a focused, manageable tool set.

Multiple providers can be configured simultaneously. Tools are namespaced by provider to avoid collisions.

**Tool classification**: `classifyToolAccess()` automatically classifies each tool as read-only or write based on its name (prefix heuristic + keyword-segment matching). Read-only tools are enabled by default; write tools require explicit opt-in via the provider settings UI. This prevents accidental infrastructure modifications.

**Provider registry** (`src/mcp/provider-registry.ts`): Manages both config-file providers (read-only) and GUI-added providers (CRUD + persistence to `providers.yaml`). Tracks connection status, tool count, and enabled tool count per provider.

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

Nine Mastra agents, each with a focused system prompt and tool subset:

| Agent | File | Tools | Purpose |
|-------|------|-------|---------|
| Chat | `chat.ts` | All (filtered) | Conversational queries |
| Anomaly Detector | `anomaly-detector.ts` | Metric queries | Detect anomalies |
| Planner | `planner.ts` | None | Generate hypotheses |
| Metrics | `metrics.ts` | Metric queries, histograms | Deep-dive metrics |
| Logs | `logs.ts` | Log queries, stats, patterns | Log correlation |
| Infra | `infra.ts` | Metric + K8s tools | Infrastructure health |
| Changes | `changes.ts` | GitLab/deployment tools | Change correlation |
| Synthesis | `synthesis.ts` | None | Combine evidence into RCA |
| Discover | `discover.ts` | Metric queries | AI service discovery |

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

**Read-only by default tool safety** — MCP tools are auto-classified as read-only or write via `classifyToolAccess()`. Read-only tools are enabled by default when a provider connects; write tools require explicit user opt-in through the provider settings UI. This prevents accidental modifications to monitoring infrastructure.

**Provider-agnostic prompts** — Agent system prompts reference roles and capabilities, not specific provider names. The same investigation workflow works with Grafana, Datadog, or any other MCP-compatible backend without prompt changes.

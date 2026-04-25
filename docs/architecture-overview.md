# Architecture

## Overview

dops-assistant is an AI-powered DevOps assistant that connects to monitoring infrastructure via MCP (Model Context Protocol) for conversational queries and automated root cause analysis.

It exposes two interfaces — a web UI on port 3000 and a terminal CLI — both backed by Mastra agents and workflows. Investigations can be triggered four ways: operator chat, Alertmanager webhooks, a background health poller, or a cron-driven proactive scan. Multiple stacks (prod, staging, dev) can run side-by-side in one deployment, each with its own providers, services, and history.

![System Overview](img/system-overview.svg)

---

## Interfaces

**Web UI** (`src/server/`) — Express server with WebSocket transport. Serves a React SPA (Vite) from `dist/web/`. Chat messages and investigation progress stream over WebSocket (`chat:stream_delta`, `investigation:phase`, `investigation:tool_call`, `scan:trigger`, `discover`). The UI is a 4-page SPA: Operations Desk, `/activity` (Investigations / Scans / Patterns / Events), `/services`, `/settings`.

**CLI** (`src/cli/`) — Terminal REPL built with Ink (React for CLIs). Same agent and workflow stack as the web server, rendered in the terminal with tool call logging, markdown rendering, and RCA reports in bordered boxes. Note: Ink requires raw stdin and does not work inside Claude Code or other piped shells — use `npm run web` for those environments.

Both interfaces share the same agent layer through duck-typed interfaces (`IChatAgent`, `IInvestigationAgent`) defined in `src/types/agent-interfaces.ts`. The server adapter (`src/server/agents.ts`) wraps Mastra agents into these interfaces.

---

## Storage

A single SQLite database (`data/<stack>/dops.sqlite`, via `better-sqlite3`) holds all persistent state. Earlier versions used filesystem JSON in `.dops/`; that's gone. Key tables:

| Table | Purpose |
|---|---|
| `stacks` | Stack registry (id, name, slug, config) |
| `investigations` | RCA reports — status, severity, root cause, timeline, evidence |
| `investigation_phases` | Per-phase timing and token usage |
| `investigation_events` | WebSocket event log (replay support for late-joining clients) |
| `investigation_feedback` | Thumbs up/down per investigation, idempotent via UNIQUE INDEX |
| `incident_patterns` | Learned patterns extracted from "useful" feedback |
| `messages` | Chat history per stack |
| `scan_runs` | Probe-tick records (probe → triage → investigate breakdown) |
| `scan_run_investigations` | Join: which investigations were dispatched by which scan run |
| `service_health_checks` | Health-poller history, used for service detail timeline |
| `service_metadata` | Operator-set alias + tags per service |
| `email_recipients` | Notification recipients with per-row severity threshold + source allowlist |
| `settings` | Key-value store for runtime settings (notification toggles, scan settings, etc.) |
| `hidden_services`, `disabled_skills` | UI hides / per-stack skill toggles |

Most tables are stack-scoped via a `stack_id` column. The DB layer (`src/server/db.ts`) takes a stack ID on every read/write and never crosses stacks.

---

## Multi-Stack Architecture

`StackManager` (`src/server/stack-manager.ts`) holds one `StackContext` per stack. Each context has its own:

- Provider registry (set of MCP providers + their connections)
- Service registry (`services.yaml` on disk)
- Health poller, scan scheduler, TTL reaper (started per-stack at boot)
- Config snapshot (provider URLs, scan cron, webhook templates)

The default stack is created from `config.yaml` at first boot. Additional stacks are created via the GUI (`POST /api/stacks`) and stored in the `stacks` table with their own config blob. Per-stack data lives under `data/<stack-slug>/`.

API requests carry a `stackId` query parameter (or fall back to the default). The route layer resolves the stack via `stackManager.resolveStackIdWithFallback()` and hands the context to the handler.

---

## Triggers

Investigations can start four ways. All four converge on `InvestigationRunner` (see below).

### 1. Operator (web UI or CLI)

A chat message hits the `IntentRouter` (`src/agents/intent.ts`). Questions go to the chat agent; incident reports launch the investigation workflow. Most messages are classified by regex fast-paths; ambiguous ones hit a `generateText` call.

### 2. Alert webhook (Alertmanager)

`POST /api/webhook/alert` (`src/server/webhook-handler.ts`) receives Alertmanager v4 payloads. The handler validates a bearer token, dedups recent alerts, extracts service / severity / labels, merges with the service's known metrics and log selectors from `services.yaml`, and starts a headless investigation. Investigation depth is per-severity configurable (`webhook.severityTemplateMap` in `config.yaml`). When the webhook secret is unset, the route returns 503 by design.

### 3. Health poller

`ServiceHealthPoller` (`src/server/service-health-poller.ts`) runs per-stack on a 60-second interval. It queries Prometheus for deployment replica counts and `up` metrics, classifies each service as healthy/degraded/down/unknown, writes to `service_health_checks`, and auto-fires a quick investigation on a healthy → down transition. `replicas == 0` is classified as DOWN (not UNKNOWN).

### 4. Proactive scan

`AnomalyProbe` (`src/server/anomaly-probe.ts`), driven by `ScanScheduler` (`src/server/scan-scheduler.ts`) on a configurable cron, evaluates **four tracks** of rules per tick:

1. **Global rules** — `globalProbeRules` in `services.yaml` (stack-wide availability, written by the discovery agent)
2. **Per-service metric rules** — `services[].probeRules` with `source: metric` (pod-restart storms, custom thresholds)
3. **Per-service log rules** — `services[].probeRules` with `source: log` (LogQL `count_over_time(... |= error)` via Loki's `metric` query type)
4. **Config-file defaults** — hardcoded fallback rules from `config.yaml` when discovery hasn't run

Each rule has hysteresis (consecutive-tick counters keyed by `${service}:${origin}:${ruleName}`) so a single flap doesn't fire a scan. Orphan rule state is GC'd each tick. When a rule trips, the probe spawns a headless investigation; the scan run lands on the Operations Desk with status, phase breakdown, and links to each child investigation.

| Trigger | Context | Depth | Requires |
|---|---|---|---|
| Operator | High (natural language + time refs) | Configurable | Nothing extra |
| Alert webhook | Medium (alert labels + service config) | Per-severity template | Alertmanager + `webhook.secret` |
| Health poller | Medium (transition info + service config) | Quick | Prometheus provider |
| Proactive scan | Medium (rule trigger + service config) | Configurable per rule | `scan.enabled: true` |

---

## Intent Routing

The `IntentRouter` (`src/agents/intent.ts`) classifies every chat message before it reaches an agent.

**Fast-paths** (no LLM call — handles the majority of messages):
- Strong keywords: "investigate", "diagnose", "rca", "troubleshoot" → investigation
- Display requests: "show me", "display" (without symptoms) → question
- Informational: "how is", "tell me about" (without symptoms) → question
- Symptom + service: "kafka is slow", "ingestion rate dropped" → investigation

**LLM fallback**: Ambiguous messages go through `generateText` with a few-shot prompt.

**Service matching** (`matchServiceFromText`, `validateLlmServiceMatch`, `resolveServiceFromHistory`): resolves which configured service a message refers to via token overlap, alias resolution (e.g. "kafka" → "kafka-brokers"), and conversation-history scanning.

**Downgrade guard**: a message that contains symptom words but doesn't name a specific service and doesn't include explicit investigation keywords is downgraded to a chat reply. Prevents general questions like "what services are unhealthy?" from picking a random service from history.

---

## Investigation Pipeline

The investigation workflow (`src/workflows/investigation.ts`) is a 6-phase Mastra workflow. It is the core of the system.

![Investigation Flow](img/investigation-flow.svg)

### Templates

Three depths, selected by trigger source:

- **`quick`** — prefetch + metrics + synthesis (~30s)
- **`standard`** — prefetch + anomaly + planning + metrics/logs + synthesis (~1 min)
- **`full`** — all 6 phases, 4 parallel evidence streams (~2-3 min, default)

### Phase 1: Prefetch context

`src/workflows/steps/prefetch/`. Discovers datasource UIDs, dashboard list with panel queries (scored against the user's message), and working log selectors. Provider-agnostic dispatch (`grafana.ts` for Grafana MCP, `generic.ts` as fallback). Without prefetching, agents waste iterations calling discovery tools instead of investigating.

### Phase 2: Anomaly detection

`src/workflows/steps/anomaly.ts`. Two modes:
- **User-reported** (most common): the user described the problem. Skip the anomaly agent, extract the time range, pass through.
- **Proactive**: no specific issue reported. Run the anomaly detector with metric tools to scan for anomalies.

### Phase 3: Planning

`src/workflows/steps/planning.ts`. Generates investigation hypotheses. Reads recent incidents from the `investigations` table AND learned `incident_patterns` (from thumbs-up feedback) to give the planner memory: "this service had a pool-exhaustion pattern last week, consider that first."

Output: focus areas for each evidence agent.

### Phase 4: Parallel evidence gathering

`src/workflows/steps/evidence.ts`. Up to four agents run concurrently, each with a focused tool subset:

| Agent | Role | Tools | Output |
|---|---|---|---|
| **Metrics** | Deep-dive metric analysis | Metric query tools | Anomalous values, baselines, timestamps |
| **Logs** | Log pattern correlation | Log query, stats, pattern tools | Error patterns, counts, sample lines |
| **Infra** | Infrastructure health | Metric + K8s tools | Resource status, pod restarts, OOM events |
| **Changes** | Change correlation | GitLab / deployment tools | Recent deployments, MRs, pipeline status |

All four use a shared `buildEvidenceStep()` that handles the common pattern: get tools by role → filter by allowlist → wrap with callbacks → run agent → extract JSON → return findings with graceful fallback. The Changes agent only runs when a provider with the `changes` role is configured.

Each agent gets only the tools relevant to its role. Providing all 50+ tools causes the LLM to skip tool use entirely or call irrelevant discovery tools.

### Phase 5: Synthesis

`src/workflows/steps/synthesis.ts`. Combines all evidence into a structured RCA report:
1. Build a chronological timeline from metric, log, and infra observations.
2. Run the synthesis agent to produce root cause, trigger, contributing factors, and recommendations.
3. **Deterministic severity validation** — `validateSeverity()` overrides the LLM's severity when evidence contradicts it (e.g. "no anomaly found" but severity is "critical" → corrected to "low").

### Phase 6: Post-synthesis

`src/workflows/steps/post-synthesis.ts`. Persists the investigation, fires notifications, optionally extracts a learnable pattern. The planning step (Phase 3) reads this back on future runs.

### Supporting modules

| File | Purpose |
|---|---|
| `tool-utils.ts` | Tool wrapping with callbacks, argument coercion (LLM type mismatches), allowlist selection |
| `schemas.ts` | Zod schemas for all step inputs/outputs |
| `helpers.ts` | Timeline building, severity validation, time-range parsing |

---

## Investigation Runner

`InvestigationRunner` (`src/server/investigation-runner.ts`) is the headless executor that all four trigger sources converge on. It exposes a `run({ trigger, service, query, template, ... })` method with pluggable callbacks for progress events, terminal output, and completion. Webhook handler, health poller, scan probe, and the WebSocket message dispatcher all instantiate it the same way; the only difference is which callbacks they attach.

The runner owns: workflow construction (template-aware), DB persistence (`investigations` + `investigation_phases` + `investigation_events`), event dispatch, error wrapping (`friendlyError()`), and graceful shutdown on cancellation.

---

## MCP Providers

`src/mcp/provider.ts`. MCP integration via `@mastra/mcp`. The system is MCP-agnostic — any MCP-compatible server can be plugged in via configuration.

Each provider declares **roles** (`metrics`, `logs`, `dashboards`, `dependencies`, `infrastructure`, `changes`) and tools are filtered per-agent by role. Multiple providers can be configured simultaneously; tools are namespaced by provider to avoid collisions.

**Tool classification**: `classifyToolAccess()` automatically classifies each tool as read-only or write based on its name (prefix heuristic + keyword-segment matching, supports both `list_pods` and `pods_list` conventions). Read-only tools are enabled by default; write tools require explicit opt-in via the GUI.

**Provider registry** (`src/mcp/provider-registry.ts`): manages config-file providers (read-only, defined in `config.yaml`) and GUI-added providers (CRUD via REST, persisted to `providers.yaml`). Tracks connection status, tool count, and enabled tool count per provider.

```yaml
providers:
  - name: grafana
    roles: [metrics, logs, dashboards]
    mcpServer: { transport: http, url: "${GRAFANA_MCP_URL}" }
  - name: kubernetes
    roles: [infrastructure]
    mcpServer: { transport: http, url: "${K8S_MCP_URL}" }
  - name: gitlab
    roles: [changes]
    mcpServer: { transport: http, url: "${GITLAB_MCP_URL}" }
  - name: coroot
    roles: [dependencies]
    mcpServer: { transport: http, url: "${COROOT_MCP_URL}" }
```

---

## Specialized Agents

`src/agents/`. Eleven Mastra agents, each with a focused system prompt and tool subset:

| Agent | File | Tools | Purpose |
|---|---|---|---|
| Intent Router | `intent.ts` | None | Classify chat → question vs investigation |
| Chat | `chat.ts` | All (filtered) | Conversational queries |
| Anomaly Detector | `anomaly-detector.ts` | Metric queries | Detect anomalies for proactive runs |
| Planner | `planner.ts` | None (history only) | Generate hypotheses, reads learned patterns |
| Metrics | `metrics.ts` | Metric queries, histograms | Deep-dive metrics |
| Logs | `logs.ts` | Log queries, stats, patterns | Log correlation |
| Infra | `infra.ts` | Metric + K8s tools | Infrastructure health |
| Changes | `changes.ts` | GitLab / deployment tools | Change correlation |
| Synthesis | `synthesis.ts` | None | Combine evidence into RCA |
| Discover | `discover.ts` | Metric + log queries | AI service discovery |
| Discover Validator | `discover-validator.ts` | None | Score discovery output for accept/reject |

**Shared utilities** (`src/agents/shared/`):
- `prepare-step.ts` — `prepareStep` hook intercepts every LLM call to handle truncation, tool filtering, and model-specific quirks (currently gpt-oss-120b's hallucinated tool calls). Removable when switching to a model without these issues.
- `processors.ts` — `safeJsonParse()` extracts JSON from LLM output that may be wrapped in markdown, prose, or code blocks.
- `time-context.ts` — Injects current time and timezone into prompts so the LLM can convert relative times to absolute timestamps.

---

## Service Registry & Discovery

The service catalog lives in `services.yaml` (per-stack) with shape `{services: [...], globalProbeRules: [...]}`. The registry store (`src/services/registry.ts`) reads it, merges with static overrides from `config.yaml` (config wins on conflicts), and serves both the runtime (probe, poller, evidence agents) and the UI.

**AI discovery** (`src/agents/discover.ts` + `src/workflows/discovery.ts`):
1. Operator hits **Run Discovery** in the GUI setup wizard (or runs `npm run discover` for headless / CI use).
2. The discover agent walks Prometheus + Loki via MCP, identifies services via label conventions, and proposes a `services.yaml` with canonical metrics, log labels, per-service probe rules, and stack-wide global rules.
3. The discover-validator agent scores the proposal across four dimensions (globals, per-service rules, PromQL parse, LogQL parse).
4. The operator reviews the result in the GUI and clicks **Accept** to commit to disk.

The discovery output is gated by a CI eval (`src/eval/discover-eval.ts`) that scores against a fixture and fails CI under 75/100.

---

## Notifications

Every completed investigation can be delivered to Slack and email. Recipients are filtered on two axes — minimum severity and allowed trigger source — so each inbox only sees what it wants.

**Slack** (`src/server/slack-notifier.ts`): single incoming webhook, configured via the GUI or `notifications.slack.url` in config. Per-investigation summary posts via `notifySlack()`. Run-level scan summaries via `notifySlackOnScanComplete()`, mode configurable: `always` / `hits-only` / `off`.

**Email** (`src/server/email-notifier.ts`): per-recipient SMTP delivery via `notifyEmail()`. Recipients live in the `email_recipients` table with `min_severity` (`critical` / `high` / `warning` / `info`) and `allowed_sources` (`webhook` / `scan` / `poller` / `manual`) per row. Body is Teams-safe HTML rendering the full RCA report (severity banner, summary, root cause + confidence, contributing factors, timeline, evidence, recommendations, deep link); plain-text fallback included.

SMTP infrastructure (host, port, credentials) is in `config.yaml` (or sourced from a Helm `extraEnvFrom` Secret). Recipient management is GUI-only at **Settings → Notifications**, with a per-row **Test** button that runs a fixture RCA through the real pipeline.

---

## Web UI

A 4-page React SPA (Vite, in `src/web/`):

- **Operations Desk** (`/`) — live SOC console: health strip, service catalog with status chips, investigation log, recent scan runs with **Scan now**, event stream rail. Drilling into a service opens a tabbed detail view (overview, metrics, history, scan).
- **Activity** (`/activity/:tab`) — unified history surface across four tabs:
  - `/activity/investigations` — filter bar, severity breakdown, search across service / query / root-cause, date-window shortcuts, URL-driven filter state. Per-investigation detail at `/investigations/:id` with shareable links and a live phase rail.
  - `/activity/scans` — paginated scan history filtered by trigger / status / hits, with deep links to each run's `/scan/runs/:id` Probe → Triage → Investigate breakdown.
  - `/activity/patterns` — learned-pattern catalog scoped by severity + service, drill-down to the source investigation that taught each pattern.
  - `/activity/events` — persistent system feed (`investigation_started`/`_completed`/`_failed`, `alert_received`, `scan_run_complete`, `scan_triggered_manually`, `provider_health_changed`) with 30-day retention, multi-axis filters (kind / severity / service / time). Events table is GC'd by `src/server/events-retention.ts`.
- **Services** (`/services` and `/services/:name`) — service catalog grid + detail view (overview, history, scan override).
- **Settings** (`/settings`) — Providers, Skills, Stacks, Scan, Notifications. Setup wizard (`SetupStepper`) guides new users through Connect Provider → Discover Services → Monitor.

Routing is client-side via `useRoute` (`src/web/hooks/useRoute.ts`) — no react-router, just `pushState` + `popstate` + a flat `parseUrl`/`viewToUrl` pair. Lazy chunks are runtime-configurable via `globalThis.__APP_BASE__` so sub-path deploys work without rebuilding the bundle.

---

## Demo Mode

Two independent mechanisms cover two scenarios:

**Live demo** (`DEMO_MODE=true`) — `src/server/demo-mode.ts` installs middleware that 403s every non-GET `/api/*` request (with a small whitelist for health + investigation feedback). The WS handler refuses chat / deep_investigate / rerun / discover / scan:trigger with canned messages. Background pollers + scan scheduler + TTL reaper aren't started. The webhook returns 503. The SPA receives `window.__DEMO_MODE__=true` via index.html rewrite and renders a banner.

**Static demo** (`VITE_DEMO_STATIC=true` build-time flag) — `src/web/lib/staticFetch.ts` intercepts all `/api/*` calls in the SPA and serves them from pre-baked JSON snapshots at `dist/web/api/*.json`. `scripts/export-static.ts` boots a seeded server briefly, walks every GET endpoint, and dumps the responses. The result is a fully server-less demo deployable to GitHub Pages with zero backend.

Seed fixtures (15 services, 5 investigations, 2 scan runs, 2 patterns, 3 stub providers) live in `scripts/seed-demo.ts`.

---

## Eval & Quality

Two evaluators score AI output quality and gate CI:

- **RCA eval** (`src/eval/rca-eval.ts`) — runs investigations against a fixture set, scores the RCA reports on 5 dimensions (root cause accuracy, evidence quality, timeline coherence, severity correctness, recommendations). Baselines under `src/eval/baselines/`. Compare a new run via `npx tsx src/eval/rca-eval.ts --compare <baseline.json>`.
- **Discovery eval** (`src/eval/discover-eval.ts`) — scores discovery output across globals, per-service rules, PromQL parse, LogQL parse. CI gates at 75/100.

Both run on every PR via `.github/workflows/`.

---

## Deployment

Three options, single codebase:

- **Docker** — single image (`Dockerfile`), mount `config.yaml` and `services.yaml`, pass `OPENAI_API_KEY`. Cross-arch + corp-network buildable.
- **Helm** — chart at `deploy/helm/dops-assistant/`. Supports sub-path ingress via `APP_BASE_PATH` env (server rewrites asset URLs at request time, no rebuild needed), SMTP credentials via `extraEnvFrom` on an existing Secret, and ingress WebSocket timeout annotations for the ~60s LLM silent-thinking phase.
- **Process manager** — `npm run build:web && npm run web` behind systemd, pm2, or your stack of choice.

Sub-path deploys (e.g. `<host>/dops/`) are runtime-configurable: don't pass `VITE_BASE_PATH` as a Docker build-arg. Set `APP_BASE_PATH` env on the running container instead.

---

## Key Design Decisions

**MCP-agnostic tool integration** — Connects to any MCP-compatible server. Tool routing is role-based, not provider-specific. Adding a new monitoring backend means adding a provider config block, not changing code.

**Role-based tool filtering** — Each agent gets only the tools relevant to its job. Providing all tools causes the LLM to skip tool use or call irrelevant tools. The allowlist is defined in `tool-utils.ts`.

**Parallel evidence gathering** — Metrics, logs, infra, and changes agents run concurrently via Mastra's `.parallel()`. Cuts investigation time by ~3-4× compared to sequential execution.

**Regex fast-paths for intent routing** — Most messages are classified without an LLM call. Only genuinely ambiguous messages hit the model.

**Graceful degradation** — Every workflow step catches errors and returns empty/default findings. A failed log agent doesn't crash the investigation — synthesis works with whatever evidence is available.

**Deterministic severity validation** — The LLM's severity judgment is validated against the evidence. If the evidence shows no anomaly, severity is corrected regardless of what the LLM said.

**SQLite + per-stack isolation** — One process can run prod, staging, and dev side-by-side. Each stack has its own DB rows (via `stack_id`), provider connections, services, and history. No cross-stack reads.

**Single headless runner** — Webhook, poller, scan, and chat all converge on `InvestigationRunner`. Adding a new trigger source means adding a new caller, not duplicating workflow plumbing.

**Discovery → registry → probe** — `services.yaml` is the source of truth for both the operator (catalog) and the runtime (probe + poller + evidence). Discovery writes it once; the operator reviews + accepts; everything downstream reads from it.

**Per-recipient notification routing** — Recipients filter independently on severity threshold and trigger source. Each inbox sees only what it asked for, so on-call doesn't get scan-noise and execs don't get warning-level pages.

**Read-only by default tool safety** — MCP tools are auto-classified read-only or write via `classifyToolAccess()`. Write tools require explicit GUI opt-in. Prevents accidental modifications to monitoring infrastructure.

**Provider-agnostic prompts** — Agent system prompts reference roles and capabilities, not specific provider names. The same investigation workflow works with Grafana, Datadog, or any other MCP-compatible backend without prompt changes.

**Duck-typed adapter pattern** — Server and CLI don't depend on Mastra directly. They call `agent.chat()` and `investigationAgent.investigate()` through interfaces. Lets us swap the workflow engine without rewriting the IO layer.

**Demo mode is two flags, not a fork** — `DEMO_MODE=true` (runtime) and `VITE_DEMO_STATIC=true` (build-time). Same source, same build pipeline. The static demo on GitHub Pages and the production server share 99% of the code path.

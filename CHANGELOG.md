# Changelog

All notable changes to this project will be documented in this file.

## [0.0.9.0] - 2026-04-15

### Added
- **Setup stepper for first-run onboarding.** First-time users (or users switching to an unconfigured stack) now see a 3-step progress bar guiding them through Connect Provider, Discover Services, and Monitor. Auto-routes to the right page at each step. Replaces the misleading 0/0/0 KPI dashboard that made the app look broken instead of unconfigured.
- **Setup-aware empty state on Dashboard.** When no providers are configured, the Operations Desk shows guidance text and a "Resume setup" button instead of zero-filled stat cards.
- **Shared `createStackFetch` utility.** Extracted from StackContext so both the StackProvider and the new setup hook can make stack-scoped API calls. Also fixes the branding fetch which was manually constructing headers.

## [0.1.5] - 2026-04-15

### Fixed
- **Discovery agent tool-arg coercion was silently dead.** Mastra's `CoreToolBuilder` validates tool input against the tool's schema BEFORE calling the wrapped execute, but only for Mastra-native tools (detected via the `Symbol.for("mastra.core.tool.Tool")` marker). Our `wrapToolsWithCallbacks` spread was copying that symbol, so Mastra rejected LLM-emitted `startTime: null` on instant Prometheus queries with "Tool input validation failed" before our `coercePrometheusArgs` ever ran. Fix: strip the marker from wrapped tools so Mastra takes the Vercel/AI-SDK path, which skips input validation and calls our execute directly. `coerceLokiArgs` was silently affected too, but its existing fixes were shape-valid (`"forward" → "backward"`) so validation passed and the wrapper still ran, masking the problem.
- **Discovery could crash on JSONC comments in LLM output.** `safeJsonParse` now strips `//` and `/* */` style comments and trailing commas while respecting JSON string boundaries, and falls back to extracting a top-level JSON array (in addition to objects) when direct parse fails. The discover agent was producing `[ {...}, /* StatefulSets */ {...}, /* DaemonSets */ {...} ]` which silently failed parse and dropped the whole discovery result.
- **Discovery made the agent hallucinate datasource UIDs.** Evidence agents get datasource hints pre-injected; the discover agent didn't, so it would invent `"prometheus-k8s"` or `"loki"` short names and eat 2-3 retry round-trips. Fix: `runDiscoverStep` pre-fetches datasource UIDs via `list_datasources` and prepends them to the prompt as an `<untrusted_datasource_hints>` block.
- **Discovery tool-arg coercion only ran when an `onToolCall` callback was wired.** Auto-discovery on cold start has no user-facing callback, so `wrapToolsWithCallbacks` was skipped entirely. Fix: always wrap, even when there's no callback.
- **Discover agent's `onStepFinish` could crash on exotic tool results.** `JSON.stringify` throws on circular refs and BigInts; an unguarded call could kill the discovery step. Wrapped in try/catch with a 500-char slice on args.

### Changed
- **Helm chart default `imagePullPolicy` is now `Always`** so re-pushing a fixed tag actually picks up the new digest instead of reusing the node's cached copy. Override per-environment if you never re-push tags.

## [0.1.4] - 2026-04-15

### Added
- **Full LLM observability.** Every LLM call now emits `start`, optional `first-chunk`, and `summary` log lines at info level. Enable with `LLM_LOG_LEVEL=info` (summaries) or `LLM_LOG_LEVEL=debug` (full prompts, responses, and tool-call detail). Before this, mid-stream hangs were invisible because logging was post-hoc.
- Red-square favicon so the browser tab is identifiable.
- Configurable `TRUST_PROXY_HOPS` env var (defaults to `1`) for deployments with non-standard proxy topology (CDN + ingress, service mesh + ingress).

### Fixed
- **False-positive auto-investigations on scaled-to-zero services.** The health poller treated `kube_deployment_status_replicas = 0` as "down", causing up to 5 concurrent auto-investigations to fire per poll cycle against workloads that were intentionally not deployed. Each burned ~60s and 25k+ LLM tokens producing misleading "severity: high" reports. Now classified as `unknown` for replica metrics, while `up = 0` scrape failures still correctly fire as `down` (metric-aware classification). The first-poll transition gate from v0.0.8.0 is preserved for real outages.
- **Express `trust proxy` not set.** Behind a k8s ingress, `req.ip` was resolving to the ingress pod's IP, causing `express-rate-limit` to share one bucket across all clients (and log `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on every request). Now per-client rate limiting works correctly.
- **LLM call hangs looked like silent failures.** Post-hoc LLM logging only emitted after the stream completed, so hangs produced no log output at all. Call-start + first-chunk logging lets you distinguish "never left the pod" from "LLM stalled" from "stream broke mid-flight".
- **Metrics agent flagged scaled-to-zero workloads as anomalies.** Added a prompt carveout telling the metrics agent that a flat-zero replica series across the full investigation window is "not deployed", not an outage. Defense-in-depth for the health-poller fix.
- **Discover agent emitted Loki-incompatible log labels for statefulsets.** `{"statefulset": "yb-master"}` doesn't match any Loki stream label in most environments. Rewrote the prompt to prefer `{"container"}` / `{"pod"}` / `{"app"}`. Existing `services.yaml` entries need regeneration via `npm run discover`.
- **Wasted LLM round-trip on Grafana query_prometheus instant queries.** LLMs passed `startTime: null` on instant queries, which the MCP tool schema rejected. Now defaulted to `"now"` before the request is sent.
- **Malformed RFC3339 from LLMs.** The logs agent truncated `2026-04-15T20:27:00.000Z` to `2026-04-15T20:27:00.Z` (empty fraction) or dropped the `Z` entirely. Time-field coercion now repairs these variants automatically.
- **Stray `stepSeconds` passed to `grafana_query_loki_logs`.** Dropped before the tool sees it (it's a Prometheus concept).
- **Discover error-path LLM calls weren't logged.** On 502s and retries, the `LLM ... start:` line had no matching completion line, breaking call-correlation tooling. Error-path `logLlmCall` now fires in both `discover.ts` and `agents.ts` chat with the error captured in the `error` field.
- **`discover.ts` hardcoded `toolCalls: []` in its log record.** Every discover investigation reported 0 tool calls regardless of what the agent actually did. Now collects real tool events via `onStepFinish`.
- **Unbounded `argsStr` accumulation in discover's `onStepFinish`.** A long discovery run with large tool arguments could balloon memory. Now sliced to 500 chars and wrapped in try/catch so JSON.stringify exceptions (BigInt, circular refs) don't crash the step.
- **Dockerfile failed to build on corporate networks.** Added `NPM_STRICT_SSL` build arg so `npm ci` can tolerate MITM proxy CA chains.

### Changed
- Removed dead `observability.port` / `observability.logLevel` fields from `config.yaml.example`. Neither was ever read by runtime code.

## [0.0.8.0] - 2026-04-09

### Added
- Grafana Explore deep links on investigation evidence items: hover to reveal "Grafana" and "Copy" action buttons on timeline entries, external-link icons on metric charts, and phase-level "Open in Grafana" links on section headers (Infrastructure, Logs).
- Re-investigate dropdown button in the investigation header with template options (Quick, Standard, Full). Re-runs use WebSocket for live progress streaming, with 30s cooldown and parent investigation lineage tracking.
- Shareable investigation URLs: each investigation has a unique URL (`/investigations/:id`) that can be copy-pasted to share with teammates. Share button in investigation header copies the link to clipboard.
- Client-side routing for all pages (`/services`, `/settings/:tab`, `/investigations/:id`). Browser back/forward works. Right-click to copy link on investigation rows and sidebar nav items.
- Unified Grafana URL builder supporting both panes (Grafana 10+) and left= (Grafana 9) formats. Preserves `orgId` and other query params from provider `webUrl`.

### Changed
- Default stack now uses `data/default/` for providers.yaml and services.yaml, consistent with all other stacks. Previously read from project root and config-relative paths.
- Config validation allows empty `providers` array (GUI-only stacks where all providers are added via the UI).
- `/api/providers` response now includes `webUrl` field for deep link generation.

### Fixed
- LLM connection errors with `ENETUNREACH` (network unreachable) now correctly surface as "LLM unreachable" in the investigation UI instead of silently producing empty results. Also catches `EHOSTUNREACH`, `ECONNRESET`, and AI SDK's "Cannot connect to API" prefix.
- SPA catch-all route uses explicit `{ root }` option for `sendFile`, fixing 404 on direct URL access (e.g. opening `/investigations/:id` in a new tab).
- Grafana deep link URLs no longer break when provider `webUrl` includes query params like `?orgId=1`.

## [0.0.7.0] - 2026-04-07

### Added
- Per-stack skill enable/disable toggles: each stack can independently turn skills on or off via a toggle switch in the Skills page. Disabled skills are excluded from investigations, discovery, and chat.
- Consul bare-metal discovery skill: teaches the discover agent to find services registered in Consul via `consul_catalog_service_node_healthy`, deduplicate against K8s services, and use `app_fortidata_name` log labels.
- Scope badges on skill cards and in the skill editor, color-coded by type (investigation, discovery, chat).
- Editable scope in the skill editor: toggle which agents receive each skill.
- Taller skill body textarea for easier editing.

## [0.0.6.0] - 2026-04-04

### Fixed
- Provider Test button now verifies end-to-end connectivity by executing a lightweight tool call, catching upstream auth failures (401) that tool listing alone misses.
- Prometheus datasource UID cached at provider init and refreshed on successful Test, eliminating intermittent health poll failures from stale MCP sessions.
- Defensive JSON parsing in datasource UID lookup prevents crash when MCP returns error text.

## [0.0.5.0] - 2026-04-04

### Fixed
- Non-default stack providers now persist to `data/{slug}/providers.yaml` instead of being lost on server restart.
- Provider `enabledToolCount` updates correctly after reconnecting a previously-failed MCP connection.
- Health poller and Metrics tab now prefer `list_datasources` over `get_datasource` for Prometheus datasource UID lookup, fixing "Prometheus connection unavailable" on stacks with non-standard UIDs.
- Service brief infrastructure section parses YAML responses from K8s MCP `resources_get`, resolves namespace from `logLabels`, and infers workload kind from metric queries.
- Service detail pages (AI Brief, alias editor, tag editor) now send the `X-Stack-Id` header, fixing empty data on non-default stacks.
- Investigation infrastructure agent queries the Deployment/StatefulSet resource directly when replicas are 0, providing "scaled to zero" evidence for root cause analysis.
- Section timeout for MCP calls increased from 3s to 10s to accommodate remote MCP servers.

### Changed
- UI polish across settings page, health strip, dashboard components.

## [0.0.4.0] - 2026-04-03

### Changed
- Section labels across all components now use JetBrains Mono with precise tracking (0.1–0.12em), matching the design system spec for uppercase labels.
- Health strip chips are tinted by health status (green/yellow/red backgrounds) with staggered fade-up entrance animation.
- Investigation rows and stat cards show a colored left accent border indicating status/variant.
- Toast notifications glow on completion (green) and failure (red) for instant visual feedback.
- RCA report cards in chat reveal with a staggered entrance animation: stripe extends, sections fade in sequentially, then a brief glow pulse fades to the resting state.
- Learned patterns and service group sections use smooth CSS grid collapse animation instead of conditional rendering.
- Chat empty state shows quick-action prompt chips ("What services are unhealthy?", etc.) and an investigation-focused message.
- Sidebar active indicator transitions smoothly via opacity/scale instead of mount/unmount.
- Provider card spacing increased for better visual rhythm.

### Fixed
- localStorage access wrapped in safe helpers (`safeGetItem`/`safeSetItem`) across all 10 call sites. Prevents crashes in SSR and test environments where localStorage may not be fully available.
- Collapsed service groups and learned patterns sections now set the `inert` attribute, preventing hidden cards from receiving keyboard focus or firing API requests.
- Investigation row hover no longer clobbers the status-colored left border.
- Confidence scores between 0 and 1 (e.g., 0.85) are normalized to percentage scale before color-coding, preventing high-confidence values from displaying as red/destructive.
- Health chip tints fall back to the `unknown` style for unexpected health status values.
- Pre-existing test failures fixed: `supertest` added as dev dependency, `rate-limit.test.ts` now runs.
- Docker Compose dev files added to `.gitignore`.

## [0.0.3.1] - 2026-04-02

### Fixed
- Investigation logs agent now searches for incident-specific keywords before generic error patterns, preventing chronic noise (config warnings, etc.) from burying critical evidence like provisioning failures.
- Planner agent extracts action keywords from user messages for targeted Loki log queries.
- Evidence step passes extracted incident keywords to the logs agent prompt, making targeted searches the default behavior.

## [0.0.3.0] - 2026-04-01

### Added
- Headless tool access lock: webhook and health-poller triggered investigations now use read-only MCP tools only. Prevents crafted alerts from triggering write operations via LLM.
- Optional API key authentication on all non-GET API routes. Configure `apiKey` in `config.yaml` to protect mutating endpoints. Backward compatible when no key is set.
- Structural prompt hardening: external content (alert labels, user messages, tool results) wrapped in `<untrusted_*>` tags to separate instructions from data in LLM prompts. Skill content is treated as trusted (operator-created runbooks).
- Boundary validation with Zod schemas for Alertmanager webhooks, WebSocket chat messages, and skill API inputs. Enforces max lengths and strips control characters.
- Tiered HTTP rate limiting: 300 req/min global, 10 req/min on LLM-triggering routes, 30 req/min on mutations. WebSocket rate limiting at 20 messages/min per connection.
- Write-keyword denylist in `classifyToolAccess()` for security-grade tool classification.
- `express.json({ limit: '1mb' })` body size limit.

### Fixed
- Timestamps normalized from SQLite format to ISO 8601 across all API responses. Fixes Safari parsing issues.
- Clear, New Chat, and Start Fresh buttons disabled during streaming to prevent orphaned messages.
- API key comparison uses constant-time comparison to prevent timing attacks.
- Timestamp normalization gracefully handles malformed data instead of crashing.
- Untrusted tag wrapper escapes both opening and closing tag patterns.
- WebSocket rate limiter cleans up prior state on re-registration to prevent interval leaks.

### Changed
- `sanitizeForPrompt()` replaced with `wrapUntrusted()` + truncation in service brief.
- Agent system prompts updated to reference untrusted content tags.

## [0.0.2.0] - 2026-04-01

### Added
- Notifications tab in Settings with Slack webhook configuration, enable/disable toggle, and test button.
- `GET/PUT /api/notifications` and `POST /api/notifications/test` API endpoints.
- `settings` table in SQLite for persisting GUI configuration (key-value store).
- Slack notifications are now configurable at runtime from the GUI without server restart.

### Changed
- Slack notification handler (`globalOnComplete`) now reads the webhook URL dynamically from the DB, falling back to `config.yaml`. Previously, the URL was captured once at startup.

## [0.0.1.0] - 2026-04-01

### Changed
- Provider form in the GUI now only supports HTTP transport. The stdio transport option, command field, args, and env vars have been removed from the add/edit provider form. Stdio remains available for power users via `config.yaml`.

### Removed
- Transport dropdown, command, args, and env var fields from the provider management GUI.
- `command` field from the GET `/api/providers` response payload.

## [0.0.0.1] - 2026-03-31

### Fixed
- Anomaly detection step now preserves tool results up to 8000 chars instead of truncating at 2000. Evidence agents were losing metric values, log lines, and infra details due to the aggressive limit.

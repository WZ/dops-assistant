# Changelog

All notable changes to this project will be documented in this file.

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

# Changelog

All notable changes to this project will be documented in this file.

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

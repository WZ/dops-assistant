# Changelog

All notable changes to this project will be documented in this file.

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

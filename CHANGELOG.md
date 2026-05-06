# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.4.3.1] - 2026-05-06

### Added
- **Global "applies to all stacks" banner** on Settings → Scan and Settings → Notifications — clearer scope indicator than the previous subtle "(from config.yaml)" hint.

### Fixed
- **Settings tabs stale after switching stacks** — Skills, Discovery, Discoveries, and email-recipients sections fetched once on mount via `stackFetch` and ignored later stack switches. Loaders are now wrapped in `useCallback` bound to `stackFetch` and the effects depend on the callback. Per-component request-id guards prevent stale stack-A responses overwriting fresher stack-B data.

## [0.4.2.0] - 2026-05-05

### Changed
- **Discovery settings tab now matches Scan tab style** — Settings → Discovery used a different visual language than Settings → Scan: a tiny `h3` mono header instead of a page-level `h1`, native checkbox instead of the custom toggle switch, fields stacked without a card wrapper, no cron presets, no descriptive paragraph between header and form, and Save/Run-now sitting inline below the form rather than top-right. The whole tab now mirrors ScanTab's anatomy: page-level Inter h1 ("Discovery") + mono subtitle, `Run now` + `Save` chips top-right (with error chip when present), vertical primary-bar section header (`PERIODIC DISCOVERY`), description paragraph, then a card-wrapped form with the same `LABEL_CLASS` / `INPUT_CLASS` constants and the same toggle switch component. Cron now offers Every-6-hours / Every-12-hours / Daily-3am / Weekly preset chips. Browser timezone is auto-detected. The Inbox and Recent Runs are now their own primary-bar sections, also card-wrapped.
- **Discoveries inbox table fixed** — column headers no longer wrap (`MISSING\nCOUNT` was wrapping in narrow columns); date cells use compact relative time (`4h ago`) with the full timestamp on hover via `title` attribute, so they no longer wrap to two lines either; Confirm-removal + Dismiss action buttons render as a single inline-flex row instead of stacking. Headers use the same `font-mono uppercase tracking-[0.1em] text-[10px]` style as the rest of Settings, with a thin `border-border/40` instead of the previous default border. All cells use `whitespace-nowrap` so column widths stay predictable.
- **Dismiss-all bulk action** — when Pending Additions or Pending Removals has any rows, a `Dismiss all (N)` outline button renders in the toolbar above the table. Confirms via `window.confirm`, fires individual `POST /api/discoveries/:id/dismiss` calls in parallel via `Promise.allSettled`, surfaces partial failures inline, and reloads. Reachable for both additions and removals; restorable from the Dismissed tab as before.
- **`DiscoveriesPage` accepts `embedded` prop** — when embedded inside `DiscoveryTab` the page-level `h1` + outer `px-4 py-5` padding suppress so the inbox reads as a section, not a duplicate page header. The standalone `/discoveries` route renders unchanged (default `embedded={false}`).

## [0.4.1.0] - 2026-05-05

### Changed
- **Console chat input is now visibly the entry point** — landing on the Console used to feel ambiguous because the chat input blended into the panel: faint `border-border/40`, a ghost icon, no label, no "you can type here" affordance. Most of the page read as informational, and new users took several seconds to realize the input was the action. Now the input box sits at h-12 with an always-visible `border-primary/30` teal tint, a subtle teal ring shadow that intensifies on hover/focus, and a filled `Ask →` pill (replacing the ghost send icon) that stays at 65% opacity even when the input is empty so it reads as primed rather than washed-out. The empty-state header shrinks to make room (32px Search icon, was 44px) and ends with an animated `↓ START HERE` mono label pointing at the input. Quick-prompt chips moved out of the empty state to anchor directly under the input as one tight cluster on first entry. Light mode tightens the ring shadow (3px at 0.04 opacity) so the teal wash is restrained; dark mode lightens the input bg to `bg-secondary/55` and brightens the border to `primary/55` so the input clearly elevates above the panel background. Deep-investigation mode is unchanged — Spotlight only applies to default Console mode.

## [0.4.0.1] - 2026-05-01

### Fixed
- **Malformed markdown tables in chat replies** — Console chat replies that contained tabular data sometimes rendered as broken paragraphs littered with stray `|` characters. Two compounding bugs: (1) the chat agent's prompt forbade tables but offered no alternative, so the model emitted them anyway with missing trailing pipes or no separator row; (2) the renderer's `normalizeBlocks` matched across newlines, splitting properly-formed multi-row tables mid-row. The renderer now walks line-by-line and accepts malformed tables (clusters of 2+ pipe-leading rows, with or without a separator row) by rendering them as a real `<table>` with padded columns. The chat agent prompt now suggests bulleted rows with em-dash field separators as the canonical alternative.

## [0.4.0.0] - 2026-05-01

### Added
- **Periodic discovery loop** — scheduled, suggest-only service discovery on top of the existing manual flow. The cron runs `runDiscovery()` per stack, applies a four-layer noise filter (validator confidence + multi-run consensus + Prometheus sanity probe + corroboration for removals), and writes qualifying suggestions to a per-stack inbox. The cron never modifies `services.yaml` directly; only the explicit accept route mutates the registry.
  - Config: `discovery.periodic { enabled, cron, timezone, consensusRuns, consensusRunsForRemovals }`. Disabled by default. Defaults: additions consensus = 2, removals = 3 (one higher because LLM prompt drift can silently zero out a service).
  - DB: 4 new tables (`pending_discoveries`, `dismissed_discoveries`, `periodic_discovery_runs`, `discovery_notifications`). Foreign keys are off project-wide so child rows are swept explicitly inside transactions.
  - Notifications: per-channel delivery state — Slack and Email are tracked independently, so a Slack success + Email failure only retries Email on the next tick (no spam). The in-app badge tracks `viewed_at` separately from push `notified_at`.
  - Routes: `GET /api/discoveries`, `/dismissed`, `/badge`, `/runs`, `GET/PUT /api/discovery/settings`, `POST /api/discoveries/{:id/accept,:id/dismiss,dismissed/:id/restore,mark-viewed,run-now,:id/accept-with-current-globals}`. Accept Zod-validates the stored payload before writing the registry (closes TODO #35) and 409s on globals_drift / registry_advanced.
  - UI: Settings → Discovery tab exposes cron config, recent runs (with token telemetry), and the inbox (Pending Additions / Pending Removals / Dismissed) inline. 409 conflicts surface a modal that offers to re-run the sanity probe against current globals.
  - Notification source enum extended with `"periodic-discovery"`. The existing `allowedSources` filter on each recipient/channel handles per-channel opt-in for free.

### Known limitations (periodic discovery)
- Periodic discovery inherits the `discovery_uses_status_replicas_not_ready` bug in the discovery agent prompt (`service_availability` rules use `kube_deployment_status_replicas` rather than `*_replicas_ready`). For services whose availability matters under crashloop/pending, operators may need to manually edit the rule. Tracked separately.
- Single-instance scheduler assumption inherited from `ScanScheduler` — running ≥2 server instances will fire ticks from each. Acceptable for current deployment topology.
- Service-name-keyed dismissal: a future genuinely-different service that reuses a dismissed name is silenced. Mitigated by the Dismissed tab's restore action.

## [0.3.9.1] - 2026-04-28

### Fixed
- **Slack and Email enable toggles now ignore spam-clicks.** Both toggles disable themselves while a PUT is in flight. Previously, two clicks within the network round-trip could each read the same stale `enabled` state and end up sending the same flipped value, leaving the user with the wrong final on/off state.
- **Slack webhook URL is validated inline before save.** Catches typos like `https//` or pasted Discord URLs at the form level instead of relying on the server to reject them silently.
- **Email recipients section's imperative refresh handle drops its empty deps array.** The handle now recomputes per render, so if the underlying stack-fetch identity ever changes (e.g., switching stacks), the handle still calls the correct one. Latent bug, no observed user impact today.

## [0.3.9.0] - 2026-04-28

### Changed
- **Settings tabs all share the same chrome.** Every tab now has an `h1` + subtitle + top-right primary action (Skills / Stacks / Scan / Notifications / Providers). Parent subtitle updated to "Providers, skills, stacks, scans, and notifications" to match the actual tab set.
- **Stacks view is a 2-column card grid** matching Skills, replacing the wide single-column rows. Inline rename (pencil → editable input) replaces the modal; `CreateStackDialog` and `RenameStackDialog` are removed.
- **Provider, Stack, Email, and Slack edits are full-page panels** — same chrome as the Skills editor (back link + small primary-tinted Save in the top bar). Modals are gone; ProviderForm exposes `triggerSave`/`triggerTest` so the Save button can live in the top bar with `Test` next to it.
- **Slack notifications mirror Email's row pattern.** Enable toggle on top, then a row showing the masked webhook URL + scan-run mode + Test button. Click the row or "Edit webhook" to open the new SlackEditor.
- **TOOLS section on provider cards is obviously expandable** — full-row hover, group-hover affordances, tool count appended to the label, cursor pointer.
- **Services view has the same filter bar as Activities.** Health chips + Tags select + Search + Sort, with `FilterGroup` and `Chip` extracted to `src/web/components/ui/filter-group.tsx` and shared with Investigations / Patterns / Events / Scans.
- **`/` focuses the search input on every search-bearing page.** Investigations, Patterns, Events, Services share `useSlashFocus` from `src/web/hooks/`.
- **Scan tab tightened** — section gaps, cron preset chip styling, per-stack status rows now match the rest of the Settings density. Save lives in the title row with the h1.
- **ScanRun Export button** now matches the Investigation Export styling (outline + DropdownMenu wrapper).

### Removed
- `CreateStackDialog.tsx` and `RenameStackDialog.tsx` — replaced by inline rename and full-page `StackEditor`.

## [0.3.8.1] - 2026-04-27

### Fixed
- **Pending search text is preserved when you click Next or Prev.** The pagination buttons now route through the same `withPendingSearch()` helper the chip handlers use — typing "redis" then clicking Next without pressing Enter sends `?q=redis&offset=25` instead of dropping the text. Same bug class as the v0.3.8.0 chip fix; pagination just hadn't been swept.
- **"Clear all filters" now empties the search input too.** Previously the URL cleared but the input kept showing whatever you'd typed — visually inconsistent. Both the URL and the input draft reset together now.

## [0.3.8.0] - 2026-04-27

### Changed
- **Investigations table now uses the same filter row as Patterns and Events.** Severity, Status, Range, Service dropdown, Search, Sort — all chip/dropdown controls with the same labels, sizing, and behavior as the rest of the activity views. The earlier severity-with-counts strip and segmented date control are gone in favor of a single consistent chip layout.
- **Service dropdown on `/investigations` is populated from the API.** `GET /api/investigations` now returns `services: string[]` — the distinct services with at least one investigation in the current stack — so the dropdown renders without a second round-trip.

### Fixed
- **Search text is no longer dropped when you click a chip without pressing Enter first.** Every chip and select handler now folds the pending search draft into its update, so typing "redis" then clicking Critical sends `?q=redis&severity=critical` instead of silently overwriting the query.
- **Service dropdown clears on fetch error** so a 400 after switching stacks can't leave the previous stack's service names visible in the new context.
- **New covering index `(stack_id, service)` on investigations** keeps the per-request distinct-service scan cheap as the table grows.

## [0.3.7.1] - 2026-04-27

### Added
- **Toggle the K8s event poller on/off from the GUI.** New "K8s Event Poller" section in Settings → Scan, sitting between Proactive Scan and Probe rules. Stores the override in the same key/value table that backs the existing scan settings, so flipping the switch survives restart. PUT to `/api/scan/settings` with `{k8sEvents: {enabled: true|false|null}}` — `null` clears the override and reverts to `config.yaml`.
- **Live per-stack status next to the toggle.** Each stack shows a colored dot and a one-line label drawn from the poller's actual last poll: green ("k8s provider detected"), amber with the specific reason it can't run on that stack (no infra MCP wired, infra MCP isn't kubernetes, last call failed), or gray ("not yet polled — flip toggle on to check"). Operators see exactly what they need to fix before the toggle does anything.
- **Hot reload, no server restart.** Flipping the toggle calls each stack's `K8sEventPoller.reload()`, which stops the running interval, swaps the config, and starts again. The in-memory restart-count cache survives the reload so a no-op toggle doesn't trip false hits on the next poll.



### Added
- **Investigations now ride out short LLM blips instead of failing on the first transient error.** A new retry wrapper sits in front of every model call and waits-then-tries-again on connection-level errors (`ECONNREFUSED`, `ETIMEDOUT`, `fetch failed`, etc.) and HTTP 408/409/429/5xx responses from the provider. Tunable via the new `llm.retry` config block: `maxAttempts` (default 8, range 1–15), `initialDelayMs` (default 2000, capped at 60s), `maxDelayMs` (default 60000), and `jitterPercent` (default 0.3 — 30% added jitter). Backoff is exponential with the cap and jitter applied per attempt.
- **Explicit failure card in the investigation panel when the LLM stays unreachable.** The right pane used to spin forever when the provider was down. It now shows a destructive banner with the actual reason — "LLM API rate limit reached", "LLM API is currently unavailable", "LLM API is unreachable", etc. — pulled from the WebSocket `investigation:failed` event so users can tell rate-limit from network outage at a glance and decide whether to retry or fix Settings → Health.
- **Chat replies surface the same friendly failure copy when intent routing or chat exhausts retries.** Previously a persistent LLM outage during chat returned a generic "Internal error". Now the WS handler converts `LlmUnavailableError` into the same human-readable string the investigation panel uses.

### Changed
- **Transient-error classification is now LLM-API-specific.** The first cut matched any error whose message contained substrings like `timeout` or `503`, which would have mislabeled Prometheus/Loki/MCP tool errors as LLM outages and triggered useless retry storms. The classifier now only fires on AI SDK `APICallError` instances (with the SDK's own `isRetryable` flag, covering 408/409/429/5xx) or bare connection-level errors walked up the cause chain (depth ≤ 5).
- **Tool-replay safety on retry.** `withLlmRetry` re-runs its callback from scratch on transient failure, which would replay any tool the agent had already invoked. The new `safeAgentRetryConfig` helper gates tool-using agent paths (anomaly, evidence, planning, synthesis) so retries only engage when `readOnlyTools` is true. Read-only call sites (intent routing, discovery's read-only tool set) keep the full retry budget.
- **Investigation runner unwraps `LlmUnavailableError.cause` before mapping to a friendly message.** Users now see the underlying network/HTTP reason instead of "LLM unavailable after retries". The friendly-error regex was also widened to match `EAI_AGAIN`, `fetch failed`, and HTTP 504 — patterns the retry classifier already recognised but the user-facing copy missed.

## [0.3.6.0] - 2026-04-26

### Added
- **Transient pod crashes now trigger investigations (opt-in).** A new `K8sEventPoller` runs every 5 minutes per stack and reads pod restart events directly from the Kubernetes API via the `infrastructure` MCP role. When a pod crashes with a bad reason (OOMKilled, CrashLoopBackOff, ImagePullBackOff, ErrImagePull, Unhealthy, Error, Failed) — or its `restartCount` increments between polls — the poller dispatches an investigation. Catches the gap where crash + restart within ~60s would slip past the existing 60s health poller and 4h scan scheduler entirely. Off by default to match the `scan.enabled` opt-in pattern; flip `k8sEvents.enabled: true` in config to enable. Configurable bad-reason list, ignore list, max events per tick, and query timeout via the same `k8sEvents` block. Reuses the shared dedup so one investigation fires per service per 5min regardless of which detector tripped.
- **Detections appear in the Activity > Events feed.** Each k8s-poller hit emits a `k8s_event_detected` audit event with severity `warn`, the bad-reason, source (`event` vs `restart-count`), pod UID, and restart count. Fires for every detection, including ones the dispatcher suppresses via dedup, so operators see "we noticed this" even when no investigation starts.
- **Three-state degraded reason on the new poller.** `getDegradedReason()` returns `infrastructure-role-not-resolved` (no infra MCP wired), `infrastructure-not-kubernetes` (infra wired but lacks `list_pods`+`list_events` — the ECS / Nomad / generic-VM case, logged at info, not warn), or `infrastructure-call-failed` (k8s tool threw or timed out). Operators see the right log level for each failure mode, and stacks running non-k8s infra silently self-disable instead of warn-spamming.
- **`k8s-event-poller` is now a notification source.** Email recipients can subscribe to it via the existing source filter. Investigations dispatched by this poller surface in templates as "K8s event poller (transient pod crashes)".

### Changed
- **`withTimeoutAndAbort` is exported from `anomaly-probe.ts`** so the new poller and any future detector can reuse the same timeout-bounded MCP call wrapper without duplicating the AbortController + chained-signal plumbing.

## [0.3.5.2] - 2026-04-25

### Fixed
- **Editing a second provider now loads that provider's values instead of the first one's.** With the inline edit form already open, clicking Edit on a different provider in the list used to keep showing the first provider's name, URL, and roles — the form mounted once and ignored later prop changes. Now the form re-seeds its inputs whenever the parent swaps in a different provider to edit.

## [0.3.5.1] - 2026-04-25

### Changed
- **Probe ticks now log a WARN when there are services configured but zero rules to evaluate.** The scheduler used to tick silently in this state — services exist, but discovery hasn't written any `probeRules`, no `globalProbeRules` are set, and `config.yaml` has no `probe.metrics` defaults. Operators stared at an empty dashboard wondering why nothing was happening. New log line: `anomaly-probe: N services configured but probe generated 0 queries — no rules to evaluate; run discovery or add probe.metrics defaults to config.yaml`. Fires once per tick (no suppression) on the scheduler's bounded cadence. Pure observability — no behavior change.

## [0.3.5.0] - 2026-04-25

### Added
- **/activity/events is live with persistence.** The Events tab on the Activity page now ships a full filter bar (severity chips, range presets including 1h, kind dropdown, service dropdown, search box), paginated rows, and click-through to whatever the event's `href` points at — typically a linked investigation or scan run. Filters round-trip through the URL — bookmark `?severity=error&kind=investigation_started&range=1h` and the chips come back lit up. Closes the Activity refactor: all four tabs now ship real implementations.
- **`events` table backed by 30-day TTL retention.** Recent events stopped living only in a 200-row in-memory ring; every `eventLog.append(...)` now also writes to a durable `events` table. Older entries don't drop silently anymore — the page can show "847 events in the last 7 days" instead of just the latest 25. Retention sweep is configurable via `config.events.retentionDays` (default 30, set `0` to disable for users with external archival pipelines).
- **`GET /api/events` filter API.** Optional filters: `kind` (CSV multi-select, open-ended — new event kinds don't need a coordinated client release), `severity` (CSV multi-select), `service` (single), `since` / `until` (ISO 8601), `q` (case-insensitive substring on summary, with `%` and `_` escaped), `limit` / `offset` for pagination. Response: `{rows, total, hasMore, kinds, services}` — the `kinds` and `services` lists power the page's dropdowns from a single round-trip.
- **`View all →` link on the Operations Desk Recent Events section.** Mirrors the affordance Investigation Log, Recent Scans, and Learned Patterns already had. Opens `/activity/events`.

### Changed
- The `EventLog` singleton (`src/server/event-log.ts`) now accepts an optional `bindDatabase(db)` call at server boot. After binding, every append writes to both the ring (for the Ops Desk strip) AND the events table (for the page). Existing call sites are unchanged — the persistence happens behind the same `eventLog.append(...)` API. Failures are best-effort; a transient DB write error doesn't break the ring.

## [0.3.4.0] - 2026-04-25

### Added
- **/activity/patterns is live.** The Patterns tab on the Activity page now ships a full filter bar (severity chips, range presets, service dropdown, search box across symptom / root cause / actions), a sort dropdown (Most recent / Severity), paginated rows, and click-through to the source investigation that produced the pattern. Filters round-trip through the URL — bookmark `?service=payments-api&severity=critical&range=7d&q=oom` and the chips come back lit up. The Operations Desk Learned Patterns section header now has a clickable `View all →` next to the expand toggle.
- **`GET /api/patterns` is now a proper list endpoint.** Optional filters: `service` (single-select), `severity` (CSV multi-select), `since` / `until` (ISO 8601), `q` (case-insensitive substring across symptom + root_cause + recommended_actions, with `%` and `_` escaped so they don't act as wildcards), `sort` (`created_at` default, or `severity` desc with newest-first tie-break), `limit` / `offset` for pagination. Response shape is `{rows, total, hasMore, services}` — `services` is the distinct list with at least one pattern in this stack so the UI dropdown populates from a single round-trip.

### Changed
- Previously `GET /api/patterns` required a `?service=X` param and 400d without it. The Dashboard's Learned Patterns section was the only caller and is updated in this PR to read `data.rows`.

### Fixed
- **Operations Desk Learned Patterns rows now show the root cause.** The section was reading `p.rootCause` (camelCase) but the API returns `root_cause` (snake_case), so the truncated text line under each pattern was silently empty. Long-standing pre-existing bug, fixed as a drive-by.

## [0.3.3.0] - 2026-04-25

### Added
- **/activity/scans is live.** The Scans tab on the Activity page now ships a full filter bar (status / trigger / outcome / range presets), a sort dropdown (Most recent / Slowest first), paginated rows, and click-through to the existing scan-run detail page. Filters round-trip through the URL — bookmark `?status=failed&range=7d&trigger=cron` and the chips come back lit up. Each row shows trigger, relative time, duration, services probed, hits summary (clean / tripped / dispatched), and status — same shape the Ops Desk Recent Scans section uses.
- **`View all N →` link on the Operations Desk Recent Scans section.** The "5 of N" hint that used to lead nowhere is now a clickable affordance that opens `/activity/scans`. Same pattern the Investigation Log got in v0.2.2.0.

### Changed
- **`GET /api/scan/runs` gains a real filter set.** Query params: `status`, `trigger`, `outcome` (CSV multi-select), `since` / `until` (ISO 8601), `sort` (`started_at` or `duration`), `offset` / `limit`. Response is now `{runs, total, hasMore}` — the legacy Ops Desk widget that reads `data.runs` and ignores extras still works without changes. The legacy `before` cursor stays for back-compat. `outcome` is derived from hits counts (raw=0 → clean, raw>0 dispatched=0 → tripped, dispatched>0 → dispatched) so the mapping can change without a migration.

## [0.3.2.0] - 2026-04-25

### Changed
- **Sidebar entry renamed to Activity, with a tabbed page underneath.** The standalone Investigations icon is now a single Activity entry that opens a tabbed view: Investigations (the existing list — same filters, same pagination, same severity strip) plus Scans, Events, and Patterns as scaffolded tabs. Each tab is its own URL (`/activity/investigations`, `/activity/scans`, `/activity/events`, `/activity/patterns`) so deep links and bookmarks work per surface. The Scans/Events/Patterns tabs are placeholders today — their real implementations land in follow-up PRs.
- **Old `/investigations` URLs silently redirect to `/activity/investigations`.** Hit an old bookmark or an external link and the URL rewrites in place via `replaceState`, preserving any filter query string. No new history entry, no flash, just a canonical URL.
- **Investigation detail back-nav still works.** Clicking back from `/investigations/:id` returns to the Activity page with your filter state intact, same as before — the smart-back behavior was preserved across the refactor.

## [0.3.1.0] - 2026-04-24

### Added
- **Thumbs-up / thumbs-down on every investigation.** A compact rating row renders under the RCA report once it lands. Hit 👍 to mark the investigation useful, 👎 to mark it not useful, or click again to switch. The Ops Desk's Learned Patterns section has existed for months but was empty on every install because nothing on the client ever called the feedback endpoint — fixed. A "useful" vote now upserts a row into `investigation_feedback` AND extracts an `incident_patterns` entry the first time (repeat clicks are idempotent, so mashing the button won't spam duplicates).
- **`GET /api/investigations/:id/feedback`** — returns the current rating (or `null`) so the UI can hydrate the thumbs state on mount. Stack-scoped.

### Changed
- **Past useful patterns now feed back into every investigation.** Voting used to be a write-only loop — `incident_patterns` rows accumulated, but no agent ever read them. Now the planner gets up to 5 patterns for the target service as priors ("if the symptom matches one of these, prioritize the same metrics/logs that confirmed last time") and synthesis gets the same set with a calibration rule ("if the current symptom + root cause match, name the pattern id and bump confidence one tier"). Each pattern: id, severity, date, symptom, root cause, recommended actions, capped at 500 chars per field. Patterns are wrapped in `<untrusted_learned_patterns>` tags — they were originally LLM-synthesized text so they cross the same trust boundary as any other agent-derived input.

### Fixed
- `POST /api/investigations/:id/feedback` now upserts on `(investigation_id, stack_id)` instead of appending a new row per click. Before: five thumbs-ups created five pattern rows. After: one pattern, first click wins, re-clicks confirm the same rating without side effects. A one-shot migration dedups any duplicate rows left by the old behavior before installing the unique index.
- `db.getFeedback()` now filters by `stack_id`, closing a cross-stack leak where a rating on one stack's investigation could bleed into another stack's view.

## [0.3.0.0] - 2026-04-24

### Added
- **Public read-only demo mode.** Set `DEMO_MODE=true` and dops-assistant boots as a public-safe showcase: every mutating HTTP request returns a structured 403, every WebSocket message that would reach an LLM or MCP backend gets a friendly refusal, and the LLM-backed REST endpoints (`/api/services/:name/brief`, `/api/services/:name/metrics`) short-circuit to demo responses instead of burning tokens or hitting Prometheus. Background jobs — health monitor, service health pollers, scan schedulers, TTL reaper, webhook handler — are all skipped at boot. A persistent amber strip at the top of the UI tells visitors what they're looking at and links to the repo.
- **One-shot deterministic seed (`scripts/seed-demo.ts`).** Writes 15 services across web/worker/datastore/infra tiers, 3 stub MCP providers (URLs that fail closed), 5 completed investigations covering all four trigger sources plus 1 frozen "running" investigation so the streaming UI shows motion, 2 scan runs, and a couple of learned incident patterns. Relative timestamps are computed at seed time, so freshness looks right on the day the seed runs.
- **Fly.io deploy pipeline for the demo.** `Dockerfile.demo`, `fly.toml`, and `.github/workflows/deploy-demo.yml` ship a public demo on push to main with auto-stop machines, scale-to-zero, and a 1GB shared-cpu VM. The seed runs on every container start; storage is ephemeral.
- **Screenshots inline in the README.** Operations Desk, investigation detail, investigations list, scan run detail, and notifications panel — captured from the demo via `scripts/capture-screenshots.ts`.
- **`npm run demo` and `npm run seed:demo`.** Local demo iteration: seed → boot. Both write to `data-demo/` (gitignored) so they never touch your real dev data.

### Changed
- **Service health poller warms its cache from the database at construction.** Without this, `getHealth()` returned an empty map until the first poll lands ~60s later, painting the Ops Desk with "0/N services" on every restart. Now the last-known status per service shows immediately. (New `Database.getLatestHealthPerService(stackId)` helper.)
- **`DATA_DIR` environment variable now controls the per-stack data root** (was hardcoded to `data/`). Default is unchanged. Lets the demo write to `/data` on a Fly volume, and the local demo write to `data-demo/`, without code changes.

## [0.2.2.5] - 2026-04-24

### Deployment
- **Configure investigation-complete email notifications from Helm.** The chart now accepts `config.notifications.email` (rendered verbatim into `config.yaml` on the pod) and a new top-level `extraEnvFrom` for pulling env vars out of existing Kubernetes Secrets. Typical setup: create a Secret with `SMTP_USER` / `SMTP_PASS`, point `extraEnvFrom` at it, and reference `${SMTP_USER}` / `${SMTP_PASS}` from inside the notifications block. SMTP credentials stay out of values.yaml. See `deploy/helm/dops-assistant/README.md` for the full example. Chart bumped to 0.1.3.

## [0.2.2.4] - 2026-04-24

### Fixed
- **Live investigation events no longer cross-contaminate between panes.** When a scan kicked off a new investigation while you had a completed investigation open, phase / tool-call / iteration / progress events from the new run leaked into the pane you were reading, mutating its phases and timeline. The events now carry the investigation id on the wire, and the pane filters by it. Companion fix to v0.2.2.3 — the nav fix handled the user-visible rerun path; this closes the latent leak on the pane the rerun left behind.

## [0.2.2.3] - 2026-04-24

### Fixed
- **Re-investigate now actually takes you to the new run.** Clicking any option in the Re-investigate dropdown (Re-run current config / Quick / Standard / Full) used to look like it did nothing: the server kicked off a fresh investigation with a new id, but the page kept showing the old report because it was still bound to the old id. Now the page auto-navigates to the new investigation as soon as it starts, so the progress bar, phase rail, and tool calls all reflect the re-run you just triggered.

## [0.2.2.2] - 2026-04-23

### Changed
- **Service detail title size matches the other pages.** The big service name header now uses the same 24px extrabold treatment as Dashboard, Services, Investigations, and Providers, so drilling into a service no longer feels like a different app.
- **Scan Run detail layout mirrors Investigation detail.** Same full-height shell, same `← back` ghost button in the top bar, same two-column dossier (300px left rail with Phases + Metadata, evidence cards on the right), and the same compact phase-rail styling. The two detail views now read as one family instead of two different screens.
- **Investigation row severity stripe colors align with the badge and the rest of the app.** The thick left-edge stripe now reads `high→warning` (gold), `medium→info` (blue), `low→secondary` (gray) — the same palette the severity badge uses on the same row, and the only severity colors the design system defines. Previously the stripe used a brighter-by-one mapping that showed a different color than the badge next to it for the same severity.

## [0.2.2.1] - 2026-04-23

### Added
- **Investigations entry in the sidebar.** The dedicated list is now one click away — no more digging for the "View all" link on the Ops Desk or pasting the URL. The icon stays highlighted when you drill into a single investigation's detail page, so you always know which section you're in.
- **Trigger source badge on every investigation row.** Scans and alerts now show a small "SCAN" / "ALERT" tag next to the service name so you can tell at a glance whether the investigation came from the proactive scanner, an alertmanager webhook, or a human question. User-initiated investigations show no badge (they're the baseline — tagging them would just be noise).
- **Smart back-nav from investigation detail.** Pressing Back on an investigation page now returns you to wherever you came from inside the app — including `/investigations` with your filters still applied. Direct-link arrivals (pasted URL, fresh tab) still fall back to the Operations Desk.

## [0.2.2.0] - 2026-04-23

### Added
- **Filter bar on /investigations.** Search by service, query, or root cause (debounced so the URL doesn't thrash on every keystroke). Toggle status (Running / Complete / Failed). Jump to a date window with one click (24h / 7d / 30d / All). Sort by most recent or highest confidence. Clear-all link surfaces only when something is actually active.
- **Severity breakdown strip.** Four clickable pills at the top of the page show how many investigations match each severity under the other active filters. Click one to filter; click again to remove. Pills with zero matches are disabled (unless already active, so you can always toggle off).
- **Responsive list rows.** Confidence + token columns drop below 1024px so the service + severity + duration + age stay readable on narrower windows. Below ~360px the metrics wrap below the service name.

### Changed
- The /investigations empty state now distinguishes "no investigations yet" (fresh stack) from "no investigations match" (filters too tight) and offers a one-click Clear-all link when filters are the reason.

### Server
- `GET /api/investigations/severity-counts` — histogram endpoint that reuses the same filter parser and drops `severity` on the server side so the strip doesn't self-filter. NULL-severity rows are excluded so the four pill counts sum to a recognizable total.

## [0.2.1.1] - 2026-04-23

### Added
- **Dedicated /investigations list page.** New route renders a paginated view of every investigation in the active stack. Reachable from a "View all N →" link that now appears in the Operations Desk's Investigation Log header whenever there are more investigations than fit in the snippet.
- **URL is the filter state.** Search params on /investigations parse into the fetch query (`?severity=critical,high`, `?status=running`, `?since=2026-04-01`, `?q=redis`, `?offset=50`, etc.). Bookmarks and copy/paste links work. Browser back/forward walks through prior filter states. Filter UI ships in the next release.

### Foundation for /investigations page
Scaffolding-only release. The page loads data and paginates, but exposes no filter controls yet — users can only set filters via the URL. Filter inputs and the severity breakdown strip are the next PR.

## [0.2.1.0] - 2026-04-23

### Added
- **Investigation severity is now a real column.** Every investigation row carries a canonical `severity` (critical/high/medium/low or null) that's populated from the RCA report at write time — no more JSON-parsing the report just to render a badge. Backfilled on server boot.
- **Filter-aware investigation API.** `GET /api/investigations` now accepts `severity`, `status`, `service`, `since`, `until`, `q` (search across service name, query, and RCA summary/root-cause), and `sort` (`created_at` or `confidence`). All query-string params are validated with a clear 400 on bad input.
- **Paginated response shape.** `GET /api/investigations` returns `{ rows, total, hasMore }` instead of a flat array, so the Ops Desk can show "3 of 47" and filter views can paginate without a second round-trip for the count.

### Changed
- Investigation rows in the dashboard, service detail, service history, and services page now read severity + confidence from dedicated columns, dropping the per-row JSON.parse on every render.
- The internal list cap moved from 100 to 10,000 so eval harnesses and health probes can pull full stack history; the HTTP cap of 100 stays at the parse layer.

### Foundation for /investigations page
This ships the API that the upcoming dedicated `/investigations` page (PR 2-4) will consume. No new UI surface in this release — existing views benefit from the faster rendering path.

### Added
- **Scan Run on the Operations Desk** — every proactive scan tick (manual or cron) now creates a durable `ScanRun` record. The Ops Desk gets a new "Recent Scans" section with a "Scan now" trigger button + collapsed history (consecutive clean cron ticks auto-fold into a single "N clean cron ticks" row so the view stays scannable).
- **Shareable scan-run detail page** at `/scan/runs/:id` with a 3-phase live view: **Probe** (services probed, queries executed, errors, duration), **Triage** (hits → dedup → dispatched, with expandable breakdown of deduped + capped-out services), and **Investigate** (mini-cards for each dispatched child investigation with live status + one-line RCA summary, click-through to the full InvestigationPane). Live updates stream via WebSocket when connected, with a 1.5s polling fallback while the run is active.
- **Export menu on scan-run detail** — copy link, copy as Markdown, download PNG snapshot, and "Send to Slack" (fires the run summary to the configured webhook with a deep link back to the run).
- **Run-level Slack + email notifications.** New `notifications.slack.onScanComplete` mode (`always | hits-only | off`, default `hits-only`) gates a run-level Slack post at `scan:complete`. Email recipients can opt into a new `scan-run` source in the NotificationsTab to receive per-tick summaries (distinct from the per-investigation emails they already get).
- **Cross-stack isolation.** `GET /api/scan/runs/:id` returns a 404 with `expectedStackId` hint when a run belongs to a different stack, so the UI can offer "switch to that stack" navigation instead of a dead end. Every scan_runs query filters by `stack_id`; `deleteStack` sweeps scan runs + investigation links in the same transaction as other child tables.
- **Retention.** TTL reaper keeps the last 200 scan runs per stack OR last 30 days, whichever is larger. Runs that dispatched investigations are pinned past the row cap so operators can always go back to "the scan from three weeks ago that flagged payments."
- **Crash recovery.** On server startup, any `scan_runs` row stuck at `status='running'` is flipped to `failed` with a clear error message, so a mid-tick crash doesn't leave perpetually-in-flight rows in the UI.
- **New tables.** `scan_runs` (one row per tick with probe + triage stats + JSON detail blobs) and `scan_run_investigations` (join table linking a run to the investigations it dispatched).
- **New WebSocket events** (`scan:started` / `:probe_complete` / `:triage_complete` / `:investigation_dispatched` / `:complete` / `:failed` / `:skipped`) emitted to the triggering connection.
- **New REST endpoints.** `GET /api/scan/runs` (paginated history), `GET /api/scan/runs/:id` (run + joined investigations), `POST /api/notifications/scan-run/send` (manual re-send to Slack).
- **Playwright E2E specs** covering the happy path, history collapse, and cross-stack isolation.

### Changed
- **`POST /api/scan/trigger` response now includes `runId`** so clients can navigate directly to the run detail page after kicking off a manual scan.
- **`runProbe` return shape** extended from `ProbeHit[]` to `{ hits, queriesExecuted, probeErrors }` so the scheduler can record accurate probe stats per tick.

## [0.1.3.0] - 2026-04-23

### Changed
- **Services scaled to zero replicas now show as DOWN instead of UNKNOWN.** Previously, a deployment with `replicas=0` (intentionally scaled down or freshly turned off) was classified as UNKNOWN — the same bucket as services with no metric data at all. That matched the engineering intuition ("scaled down is not a failure") but not the operator intuition ("I turned this off — the system should notice"). Now every scaled-to-zero workload surfaces as DOWN in the Services page. Services with no metric presence at all still show as UNKNOWN.

  The auto-investigation behavior is unchanged on boot: the poller continues to skip first-poll investigations for services that are DOWN only because of `replicas=0`, so a stack with N intentionally-disabled services does not fire N LLM investigations on every server restart. A real scrape failure (`up=0`) still auto-investigates on first poll, as before.

## [0.1.2.0] - 2026-04-23

### Added
- **Cron schedule presets on Settings → Scan.** Five one-click pills (Every 15 min, Hourly, Every 4 hours, Daily, Weekly) fill the schedule field for you. The pill matching the current value is highlighted so you can see at a glance which cadence your scan is on, if any. Typing a custom expression still works.
- **Timezone now defaults to your browser's timezone** on first visit to Settings → Scan (previously defaulted to UTC). The Save button lights up so you can persist it with one click. Users who explicitly want UTC or another timezone can type it in and save.

### Changed
- **Settings → Scan reads like product copy, not engineer copy.** Every helper sentence on the tab has been rewritten without internal jargon (no more "probe", "tick", "trip", "PromQL" where it isn't needed). Helper text has been lifted to a readable size. The page blurb now leads with what the feature does for the user, not how it works internally. The Probe Rules editor was re-labeled to match ("Scans in a row" instead of "Consecutive ticks").
- **Rule cards on Settings → Scan now look tidy.** The three per-rule header actions (move up, move down, remove) are a single compact icon strip instead of three differently-styled bordered buttons. Destructive hover only on the × icon.
- **Add / Edit recipient modal on Settings → Notifications now matches the dark theme.** The modal was rendering on a white card with default browser form controls; it now uses the same `bg-card` surface, semantic color tokens, `accent-primary` radios/checkboxes, and the shared `Button` component as the rest of the page. Backdrop gains blur. Dialog gets proper ARIA.

### Removed
- **Duplicate Status block on Settings → Scan.** Live status (next run, last run, "Scan now") already lives in the Operation Desk view; keeping a second copy in Settings forced a 10s polling loop that tab didn't need. The Settings tab is now settings-only.

## [0.1.1.0] - 2026-04-23

### Fixed
- **Email recipients section on Settings → Notifications now matches the dark theme.** The recipients list was rendering against a white background with a dark pill button, a visual break in the otherwise dark SOC operations console. The section now lives in the same bordered card as the Slack section, uses the semantic color tokens (`bg-card`, `border-border`, `text-muted-foreground`) the rest of the app uses, and reuses the shared `Button` component for "+ Add recipient" and the per-row Test / Edit / Delete actions. Added an `| EMAIL` uppercase section label and a global enable/disable toggle that mirrors Slack's, so both notification channels now read as siblings at a glance.

## [0.1.0.0] - 2026-04-22

### Added
- **Operators stop hand-crafting probe rules.** The discovery agent (`npm run discover`) now writes the rules the scan probe evaluates. Every service gets per-service `probeRules` (e.g. `pod_restarts` with the service's real k8s namespace, `log_errors` with the service's actual Loki labels). A top-level `globalProbeRules` block carries stack-aware availability rules written after the agent introspects whichever label key the stack actually uses (`app`, `service`, `job`, `deployment`, etc.). Stacks that match the hardcoded k8s defaults leave `globalProbeRules: []` and fall through to the config.yaml defaults — no duplication.
- **The probe now catches k8s pod restart storms and log error bursts.** Previously the probe only ran PromQL against Prometheus. New four-track evaluator: track 1 is discovery-written globals, track 2 is per-service metric rules (k8s restarts), track 3 is per-service log-source rules (Loki `count_over_time(... |= error)`), track 4 is the hardcoded config.yaml defaults as the fallback when discovery has never run. A `probe.logs` fallback auto-generates a LogQL from a service's `logLabels` when discovery didn't write one and the label set is non-empty.
- **Loki log-count queries are now scalar-returning.** `executeInstantLogs` calls Grafana MCP's `query_loki_logs` with `queryType: "metric"` so `sum(count_over_time(...))` returns a scalar (vs. log lines). Falls back to NaN silently when the Loki MCP tool doesn't support that mode — metrics-source rules keep running.
- **Separate `probe.logsQueryTimeoutMs` config** (default 10s) for log-source rules. The 3s Prometheus timeout regularly expires on 15m Loki windows; using it for both produced silent false negatives that looked indistinguishable from "no errors."
- **Discovery output quality gate.** New `npm run test:discover-eval` scores the LLM's discovery output across four 25-point dimensions: globals present, per-service rules present, PromQL parses, LogQL parses. Fixture at `src/eval/fixtures/discover-k8s-fixture.yaml` scores 100/100; CI gates at 75. Catches prompt regressions before they reach runtime.
- **Hysteresis state is origin-namespaced.** Consecutive-tick counters are keyed by `${service}:${origin}:${ruleName}` so a discovery-written global `availability` rule and an operator-written per-service `availability` rule never share a counter — each tracks independently.
- **Orphan garbage collection at tick start.** The probe drops consecutive-tick counters whose rule is no longer active (renamed by discovery, removed, service hidden). Prevents unbounded Map growth across re-discovery runs.

### Changed
- **`services.yaml` shape inverted** from a flat service array to `{services, globalProbeRules}`. Existing installs continue to work: the forward-compat reader transparently converts the old flat array on first load, and the next write upgrades the on-disk format. Every `registryStore.save()` call now preserves the current file's `globalProbeRules` so routes.ts-driven edits (rename, metadata PUT, rollback) cannot silently clobber the discovery-written top-level rules.
- **Sub-path is now runtime-configurable via `APP_BASE_PATH` env var** instead of baked into the image via `VITE_BASE_PATH` build-arg. Previous flow required rebuilding the image per deploy environment (blank page if you forgot). Now one generic image serves any sub-path: the server rewrites `index.html` asset references and injects `window.__APP_BASE__` at serve time; the web bundle reads the base from that global with fallback to `import.meta.env.BASE_URL`. `VITE_BASE_PATH` still works as a build-time default but is no longer required for sub-path deploys.

### Fixed
- **LLM-written probe rules are validated before persistence.** `runDiscoverStep` now safeParses every discovery-emitted rule through `ProbeMetricRuleSchema` and rejects names containing `:` (the state-key delimiter). Malformed threshold ops, wrong-enum `source` values ("log" typo → silent routing to the Prometheus tool), and colon-bearing names are dropped with a warn log per-rule instead of propagating into services.yaml and corrupting the scan-scheduler state.
- **Discovery's `globalProbeRules` now survive an empty service sweep.** Previously a transient zero-services run would silently erase the learned label-key override; `runDiscoverStep` now accepts the object form when either services or `globalProbeRules` is non-empty.
- **Sync `package.json.version` back in line with the VERSION file.** Stale from the old 3-digit scheme; now both report `0.1.0.0`.

## [0.0.10.0] - 2026-04-22

### Added
- **Email notifications, alongside the existing Slack notifier.** Every completed investigation can now be delivered to any email address — primary target: Microsoft Teams channel email addresses via Teams' email-to-channel feature. Recipients are filtered independently on two axes: minimum severity (low / medium / high / critical) and allowed trigger source (webhook, proactive scan, health poller, or manual investigation), so each inbox only sees what it wants. The HTML body is Teams-safe (inline styles, common-tag allowlist, no external CSS or images) and renders the full RCA report: severity-coloured banner, summary, impact, trigger, root cause with confidence, contributing factors, timeline, evidence (metrics/logs/infra/changes), recommended actions, dashboard links, and a deep link back to the investigation in the web UI. Plain-text fallback included.
- **New `notifications.email` config section** with SMTP settings (`host`, `port`, `secure`, `user`, `pass` via env substitution), `from` address, `appBaseUrl` for building "Open investigation" links, and retry policy (`attempts` + `backoffMs`). Startup validation enforces `backoffMs.length === attempts - 1`.
- **GUI for recipient management.** A new Email section appears beneath Slack on the Notifications tab. Add / edit / delete / toggle recipients without a server restart. Each recipient has a label, email address, severity threshold, source allowlist, and enable flag. A per-row "Test" button sends a fixture RCA through the real SMTP pipeline and surfaces failures inline — useful for validating Teams tenant sender-acceptance rules.
- **Six new REST endpoints** under `/api/notifications/email/*` (global GET/PUT + recipient CRUD + test-send), following the existing Slack notification endpoint patterns.
- **Notification source enum threaded through the runner.** Every `runner.run()` call now declares how the investigation was triggered (`webhook` / `scan` / `poller` / `manual`), so the notifier can route by source. Enforced by the type system — `source` is a required field on `RunOptions`.
- **Setup guide at `docs/email-notifications-setup.md`** covering SMTP env vars, config schema, GUI walkthrough, Teams tenant acceptance rules, and troubleshooting.

## [0.0.9.2] - 2026-04-16

### Fixed
- **Users hit 429 frequently during normal browsing.** MetricsPanel fires up to 5 parallel `/api/metrics/extract` calls per investigation view, so the strict limiter (10/min) exhausted in 2 views. Bumped limits: global 300 → 1200/min, strict 10 → 60/min, moderate 30 → 120/min. Accommodates real GUI behavior and multi-user deployments behind a shared corporate proxy IP.

## [0.0.9.1] - 2026-04-16

### Fixed
- **Discovery stuck at "Discovering services..." behind reverse proxies.** The WebSocket server had no ping/pong heartbeat. During the LLM's 50-65 second silent thinking phase (after tool calls finish), nginx-ingress treated the connection as idle and killed it. The server's `send()` silently dropped discovery results because `ws.readyState !== OPEN`. Added 30-second ping/pong heartbeat to keep connections alive through proxies. Also added WebSocket timeout annotation examples to the Helm ingress values.

## [0.1.10] - 2026-04-16

### Fixed
- **Discovery failed on every attempt due to response truncation.** `max_tokens: 16384` was too small for 71-service environments (~50k chars output). The JSON array was truncated mid-element and `safeJsonParse` had no recovery strategy, causing all 3 retry attempts to fail (~300s and ~108k input tokens wasted). Increased to 32768 and added `recoverTruncatedJsonArray` to `safeJsonParse` as belt-and-suspenders: finds the last complete JSON object in a truncated `[{...}, {... ` array and closes it. Loses the last partial element but preserves all complete ones.
- **`queryType: null` validation error on every first Prometheus call.** LLM consistently sends `queryType: null` on instant queries. Added to `coercePrometheusArgs` alongside the existing `startTime/endTime/stepSeconds` coercions. Eliminates 1 wasted tool call per discovery attempt.
- **Discovery parse failure logging was opaque.** "discovery returned empty result" gave no indication of whether the response was truncated, malformed, or empty. Now logs the response length and first/last 200 chars so truncation vs malformed format is diagnosable from the log line alone.

### Added
- **Discovery retry visibility in UI.** When the discover agent retries after a parse failure, the UI now shows "Attempt 2 of 3 — previous attempt failed (parse failed)" instead of looking stuck on "Discovering services...". New `discover:retry` WebSocket event, wired through from `runDiscoverStep` → `ws-handler` → `App.tsx` → `DiscoveryProgress`.

## [0.1.9] - 2026-04-16

### Fixed
- **Discovery agent hallucinated datasource UIDs.** The LLM consistently passed `datasourceUid: "prometheus"` (short name) instead of the real UID, causing `Tool input validation` errors and wasting 2-4 tool call retries per discovery run. Two-layer fix: (1) `wrapToolsWithCallbacks` now intercepts hallucinated short names ("prometheus", "loki") and substitutes the real UID from a pre-built map before the MCP call is sent, with info-level logging when substitution fires; (2) the discover agent's system prompt now renders datasource UIDs in a dedicated "CRITICAL: non-negotiable" block, separated from the recipe suggestions that previously gave the agent permission to ignore hints.
- **Evidence and anomaly agents were not protected against the same datasource UID hallucination.** Extended the UID coercion map through `WorkflowConfig` to all investigation phases (metrics, logs, infrastructure, changes, anomaly detection).

## [0.1.8] - 2026-04-16

### Added
- **Full LLM prompts logged at debug level on call-start**, not just completion. `logLlmCallStart` now accepts an optional `prompt` field; with `LLM_LOG_LEVEL=debug` you'll see a separate `LLM <agent> start prompt` line alongside the info summary. Previously the full prompt was only visible in the completion log, so mid-call hangs gave you no way to inspect what the model saw.
- **Per-tool-call agentic loop logging.** `logToolCall` now emits an info summary (`Tool <agent>.<tool>: Nchars Nms`) plus optional debug details (args + result) for every tool call inside discover, evidence phases (metrics/logs/infrastructure/changes), and chat. Previously discover and evidence collected tool events silently and only flushed them in the final LLM call summary, so you couldn't watch an investigation unfold in real time.

## [0.1.7] - 2026-04-15

### Fixed
- **Accepting a discovery result left the operator on the Services page instead of the Operations Desk.** After clicking Accept, the grid view would re-render with the now-populated service list but the operator still had to manually click the Dashboard nav item to see the new services in the live catalog. Now the Accept action triggers an automatic redirect to the Operations Desk right after the `discover:accept` message is sent so the freshly-populated list is immediately usable.

## [0.1.6] - 2026-04-15

### Fixed
- **Discover debug log elided the prompt hints.** The `logLlmCall` in `runDiscoverStep` was logging `prompt: "...\n\n[hints: 917 chars]"` with a placeholder instead of the real hints block, so the `LLM discover details` debug entry showed only the user-facing stub and not the datasource hints, recipes, and skills that were actually injected into the system prompt. Inlined the full `fullHints` content so `LLM_LOG_LEVEL=debug` shows the complete LLM request.

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

# TODOS

## P1 — High Priority

### DB-Backed Webhook Dedup
Add database query to webhook handler as fallback dedup check alongside in-memory map.
- **Why:** In-memory dedup map resets on server restart. Docker containers restart. Without DB fallback, same alert triggers duplicate investigation after restart, wasting LLM tokens.
- **Effort:** S (human) → S (CC)
- **Depends on:** Nothing
- **Context:** `webhook-handler.ts` line 87 uses `new Map<string, number>()` for dedup. Add: `SELECT 1 FROM investigations WHERE service = ? AND created_at > datetime('now', '-' || ? || ' minutes') LIMIT 1` as fallback when in-memory map misses. Keep in-memory map for burst dedup (sub-second). Found during eng review 2026-03-18.

### Webhook + Feedback Test Coverage
Add missing tests for webhook dedup/concurrency and feedback/pattern-extraction paths.
- **Why:** These are cost-control (dedup prevents token waste) and data-integrity (patterns) paths. Without tests, regressions are silent.
- **Effort:** S (human) → S (CC)
- **Depends on:** Nothing
- **Context:** ~6 tests needed: (1) dedup — same service within window → 200 skip, (2) dedup — different service → 202, (3) concurrency — 4th concurrent → 429, (4) feedback valid rating accepted, (5) feedback invalid rating → 400, (6) feedback positive → pattern extracted, (7) feedback with malformed report JSON → graceful fallback. Use existing `mockReqRes` pattern from `webhook-handler.test.ts`. Found during eng review 2026-03-18.

### Slack Notification Delivery
Post RCA summary to a configured Slack channel via incoming webhook after investigation completes.
- **Why:** Alert-triggered investigations need delivery — RCA results in a DB nobody checks are useless
- **Effort:** S (human) → S (CC)
- **Depends on:** Alert webhook + InvestigationRunner
- **Context:** Alertmanager fires → webhook triggers investigation → RCA persists to DB → Slack adapter reads result and posts formatted message (severity badge, timeline summary, top findings, link to GUI). Config: `notifications.slack.webhookUrl` + `notifications.slack.channel`.

## P2 — Medium Priority

### Proactive Anomaly Detection Loop
Configurable cron-style scan of all registered services. If anomaly severity exceeds threshold, auto-triggers investigation.
- **Why:** Shifts from reactive to proactive — catches issues before alerts fire
- **Effort:** M (human) → S (CC)
- **Depends on:** Alert webhook + InvestigationRunner
- **Context:** Anomaly detector agent already exists (`src/agents/anomaly-detector.ts`). Needs: a scheduler (setInterval or node-cron), configurable scan interval + severity threshold, integration with InvestigationRunner for auto-trigger. False positive tuning requires real production data — don't ship without a severity threshold config.

### Multi-LLM Provider Support
Config supports multiple LLM providers with per-agent model assignment.
- **Why:** Cost optimization + model flexibility + removes gpt-oss-120b quirk coupling
- **Effort:** L (human) → M (CC)
- **Context:** Currently all agents share one model from `config.llm`. Expansion: `config.llm.providers[]` with named providers, `config.llm.agentAssignments` mapping agent→provider. High-value agents (synthesis) get best model; cheap agents (intent) get fast one. Also refactors `prepare-step.ts` to provider-specific quirk handling instead of global. Largest scope item — touches config schema, all agent creation paths, prepareStep.

### Prompt Injection Hardening
Sanitize external inputs (Alertmanager labels, user-controlled strings) before injecting into agent prompts.
- **Why:** Security hygiene as the tool becomes deployable
- **Effort:** S (human) → S (CC)
- **Context:** Alertmanager labels flow into investigation agent prompts. Currently no sanitization layer. Add a `sanitizeExternalInput(str)` utility that strips control characters, truncates to max length, and escapes prompt-delimiter patterns. Apply to: alert labels, user chat input, service names from external sources.

### Rate Limiting on API Endpoints
Add express-rate-limit middleware to /api/* routes.
- **Why:** Dockerfile makes endpoints internet-facing; prevents DoS on unauthenticated routes
- **Effort:** S (human) → S (CC)
- **Depends on:** Nothing
- **Context:** Alert webhook has bearer token auth, but GET /api/investigations, GET /api/services, etc. have no protection. In-memory rate limiter is sufficient for single-instance (resets on restart). Standard 5-line Express middleware pattern.

## P3 — Low Priority

_(Create DESIGN.md — completed 2026-03-18 via /design-consultation)_

### A11y Specs for Incident Intelligence UI Features
Add responsive layouts and ARIA attributes for: feedback prompt, copy-as-markdown toast, alert-triggered investigation cards, and similar incident highlight.
- **Why:** Template selector and dependency graph have a11y specs; these 4 features don't. Inconsistent a11y across the same plan.
- **Effort:** S (human) → S (CC)
- **Depends on:** Incident Intelligence Platform implementation
- **Context:** Deferred during plan-design-review (2026-03-18). Minimum: `aria-live` on toast, `role="group"` on feedback, `aria-label` on historical investigation links, 44px touch targets on mobile for all interactive elements.

### Keyboard Navigation for Investigation Log
Add j/k/Enter/Escape keyboard shortcuts for navigating investigation log rows.
- **Why:** SREs live in terminals — keyboard shortcuts for the investigation list feel native and speed up incident triage.
- **Effort:** S (human) → S (CC)
- **Depends on:** Dashboard redesign implementation
- **Context:** Deferred during plan-ceo-review (2026-03-18). InvestigationRow already has `tabIndex={0}` and `onKeyDown` for Enter. Extend with a focus-managed list: j=next row, k=previous row, Enter=open investigation, Escape=deselect. Use a `useRef` array to track row DOM refs for programmatic focus. The investigation log renders up to 15 rows (`.slice(0, 15)`).

### Table Semantics for Dashboard Investigation Log
Add `role="table"`, `role="row"`, `role="cell"` to Investigation Log div-based layout for screen reader compatibility.
- **Why:** Investigation Log presents tabular data (service, root cause, confidence, tokens, time) using div layout. Screen readers can't navigate this as a table without ARIA table roles.
- **Effort:** S (human) → S (CC)
- **Depends on:** Dashboard redesign implementation
- **Context:** Deferred during plan-design-review (2026-03-18). The InvestigationRow component uses div layout for styling flexibility. Add `role="table"` on container, `role="row"` on each InvestigationRow, `role="cell"` on each data cell. Also add `aria-label` on the table container ("Investigation history").

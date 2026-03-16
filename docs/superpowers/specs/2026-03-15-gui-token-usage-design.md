# GUI Token & Timing Display

**Date:** 2026-03-15
**Branch:** `feature/cli-enhance`
**Status:** Approved

## Motivation

Token usage tracking is now wired in the Mastra adapters (chat and investigation), but the web GUI doesn't display it. Users need visibility into token costs and timing at every level — per-phase, per-chat-message, and overall totals — to understand agent efficiency and optimize prompts.

## WebSocket Protocol Changes

### New Message Types

All three must be added to the `ServerMessage` union in `src/types/ws-types.ts`.

**`investigation:phase_usage`** — emitted when a phase completes:
```typescript
{
  type: "investigation:phase_usage";
  investigationId: string;
  phase: string;       // Frontend phase name (e.g., "planning", "metrics", "synthesis")
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
```

The `phase` field uses **frontend phase names** (matching the `phase` field in existing `investigation:phase` messages), not raw backend phase names. When a single backend phase maps to multiple frontend phases (e.g., `"Analyzing metrics, logs & infrastructure"` → `["metrics", "logs", "infra"]`), the token total is emitted once under the first frontend phase name. The parallel evidence phases share a single agent step, so tokens cannot be meaningfully split.

**`investigation:total_usage`** — emitted once after `investigation:complete` (on success only):
```typescript
{
  type: "investigation:total_usage";
  investigationId: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
```

On investigation failure (`investigation:failed`), this message is **not emitted**. The total summary bar is only rendered when `investigation:total_usage` is received.

**`chat:usage`** — emitted after `chat:stream_end`:
```typescript
{
  type: "chat:usage";
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
```

## Frontend Display

### Token Formatting

Compact display using a shared formatter (`src/web/lib/formatTokens.ts`):
- `< 1000` → literal number (e.g., `892`)
- `1,000 – 999,999` → `18.2k`
- `>= 1,000,000` → `1.2M`

### Investigation — PhaseStepper Stats

Each phase's existing stats badge gains a token count:

```
10 tools · 4 iterations · 12.3s · 18.2k tok
```

**Data flow:** `InvestigationPane.tsx` maintains a `phaseTokens: Record<string, { inputTokens: number; outputTokens: number }>` state, populated by handling `investigation:phase_usage` messages. This map is passed as a prop to `PhaseStepper`, which reads it by phase name to render the token badge alongside existing `PhaseStats` data.

### Investigation — Total Summary Bar

Rendered below the `RcaReport` component after investigation completes. Uses the same muted/dim style as `ActivityTimeline`:

```
Total: 54.7k input · 6.3k output · 61.0k tokens · 35.4s
```

Data comes from `investigation:total_usage` message for live investigations. For historical investigations, data comes from DB columns on the `investigations` table, served via the `/api/investigations/:id` REST endpoint.

### Chat — Per-Message Usage

Small muted text below each assistant message:

```
3.8k tokens · 1.2s
```

Only shown for messages that have usage data. Historical messages (loaded from DB) will not have usage data — this is live-only, a known trade-off.

### Chat — Session Footer

Sticky footer at bottom of chat pane, labeled "This session" to distinguish from historical messages:

```
This session: 24.1k tokens · 12 messages
```

Resets on `new_session`. Accumulates `inputTokens + outputTokens` from each `chat:usage` event received during the current WebSocket connection. Does not retroactively count hydrated historical messages — this is intentional and the "This session" label makes it clear.

## Backend Wiring

### Investigation Token Tracking (ws-handler.ts)

1. At `investigation:started`, create per-investigation accumulators:
   ```typescript
   const totalUsage = { inputTokens: 0, outputTokens: 0 };
   const phaseUsage = { inputTokens: 0, outputTokens: 0 };
   ```

2. **Pass `onTokenUsage` to `investigationAgent.investigate()`** — the current call site passes `undefined` for this argument. Change it to a lambda that accumulates into both `totalUsage` and `phaseUsage`:
   ```typescript
   const onTokenUsage = (u: TokenUsage) => {
     totalUsage.inputTokens += u.inputTokens;
     totalUsage.outputTokens += u.outputTokens;
     phaseUsage.inputTokens += u.inputTokens;
     phaseUsage.outputTokens += u.outputTokens;
   };
   ```

3. On each `onPhase` transition (when completing a phase), emit `investigation:phase_usage` with `phaseUsage` values and the phase's duration using **frontend phase names** (from `mapBackendPhase()`), then reset `phaseUsage` to zeros.

4. After `investigation:complete`, emit `investigation:total_usage` with `totalUsage` and overall duration. Persist totals to DB via `updateInvestigation()`.

5. On `investigation:failed`, do **not** emit `investigation:total_usage`.

### Chat Token Tracking (ws-handler.ts)

1. Record start time when chat request is received.

2. **Pass `onTokenUsage` in the `agent.chat()` request** — the current call sites (both conversational and deep-investigate paths) do not include `onTokenUsage` in the `ChatRequest` object. Add it:
   ```typescript
   const chatUsage = { inputTokens: 0, outputTokens: 0 };
   const onTokenUsage = (u: TokenUsage) => {
     chatUsage.inputTokens += u.inputTokens;
     chatUsage.outputTokens += u.outputTokens;
   };
   // Pass in ChatRequest:
   agent.chat({ ...request, onTokenUsage });
   ```

3. After `chat:stream_end`, emit `chat:usage` with `chatUsage` and `Date.now() - startTime`.

### No Workflow Step Changes

The workflow steps already emit `onTokenUsage` via `onStepFinish` (anomaly, planning, evidence) and `agent.generate()` results (planning, synthesis). The chat adapter emits via `stream.totalUsage`. No changes needed in workflow code.

## Database Schema Changes

### Migrations (db.ts)

Add three columns to the `investigations` table:

```sql
ALTER TABLE investigations ADD COLUMN total_input_tokens INTEGER DEFAULT 0;
ALTER TABLE investigations ADD COLUMN total_output_tokens INTEGER DEFAULT 0;
ALTER TABLE investigations ADD COLUMN total_duration_ms INTEGER DEFAULT 0;
```

Applied in `db.ts` init, same pattern as existing schema setup (additive migration with `ALTER TABLE` wrapped in try/catch for idempotency).

### updateInvestigation() (db.ts)

Extend the method signature and `InvestigationRow` type to accept and return the three new columns:
```typescript
updateInvestigation(id: string, data: {
  status?: string;
  report?: string;
  completed_at?: string;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_duration_ms?: number;
})
```

### REST API (routes.ts)

The `GET /api/investigations/:id` endpoint must include the three new columns in its response so historical investigations can display the total summary bar. No new endpoint needed — just ensure the existing response shape includes `totalInputTokens`, `totalOutputTokens`, `totalDurationMs` from the row.

## Files Changed

### Backend
- `src/types/ws-types.ts` — add 3 new types to `ServerMessage` union
- `src/server/ws-handler.ts` — pass `onTokenUsage` callbacks at both `investigate()` and `agent.chat()` call sites, accumulate tokens, emit new WS events, persist totals
- `src/server/db.ts` — add 3 columns, extend `updateInvestigation()` and `InvestigationRow`
- `src/server/routes.ts` — include token columns in `/api/investigations/:id` response

### Frontend
- `src/web/components/InvestigationPane.tsx` — maintain `phaseTokens` state from WS events, pass to PhaseStepper, render total summary bar
- `src/web/components/PhaseStepper.tsx` — accept `phaseTokens` prop, render token count in stats badge
- `src/web/components/ChatPane.tsx` — per-message usage display + "This session" footer
- `src/web/lib/formatTokens.ts` (new) — shared compact token formatter

# GUI Token & Timing Display

**Date:** 2026-03-15
**Branch:** `feature/cli-enhance`
**Status:** Approved

## Motivation

Token usage tracking is now wired in the Mastra adapters (chat and investigation), but the web GUI doesn't display it. Users need visibility into token costs and timing at every level — per-phase, per-tool-call, per-chat-message, and overall totals — to understand agent efficiency and optimize prompts.

## WebSocket Protocol Changes

### New Message Types

**`investigation:phase_usage`** — emitted when a phase completes:
```typescript
{
  type: "investigation:phase_usage";
  investigationId: string;
  phase: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
```

**`investigation:total_usage`** — emitted once after `investigation:complete`:
```typescript
{
  type: "investigation:total_usage";
  investigationId: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
```

**`chat:usage`** — emitted after `chat:stream_end`:
```typescript
{
  type: "chat:usage";
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
```

### Modified Message Types

**`investigation:tool_call`** — add optional token fields:
```typescript
{
  // ...existing fields (phase, tool, args, status, result, durationMs)
  inputTokens?: number;
  outputTokens?: number;
}
```

These are populated per-agent-step (not per-tool), so most tool calls will have `undefined` tokens. Only the final tool call in each agent step carries the step's token usage.

## Frontend Display

### Token Formatting

Compact display using a shared formatter:
- `< 1000` → literal number (e.g., `892`)
- `1,000 – 999,999` → `18.2k`
- `>= 1,000,000` → `1.2M`

### Investigation — PhaseStepper Stats

Each phase's existing stats badge gains a token count:

```
10 tools · 4 iterations · 12.3s · 18.2k tok
```

Token data comes from `investigation:phase_usage` messages, matched by `investigationId` and `phase`.

### Investigation — Total Summary Bar

Rendered below the `RcaReport` component after investigation completes. Uses the same muted/dim style as `ActivityTimeline`:

```
Total: 54.7k input · 6.3k output · 61.0k tokens · 35.4s
```

Data comes from `investigation:total_usage` message. For historical investigations, data comes from DB columns on the `investigations` table.

### Chat — Per-Message Usage

Small muted text below each assistant message:

```
3.8k tokens · 1.2s
```

Only shown for messages that have usage data. Historical messages (loaded from DB) will not have usage data — this is live-only.

Data comes from `chat:usage` message, associated with the preceding `chat:stream_end`.

### Chat — Session Footer

Sticky footer at bottom of chat pane, accumulates across all messages in the session:

```
Session: 24.1k tokens · 12 messages
```

Resets on `new_session`. Accumulates `inputTokens + outputTokens` from each `chat:usage` event.

## Backend Wiring (ws-handler.ts)

### Investigation Token Tracking

1. At `investigation:started`, create a per-investigation accumulator:
   ```typescript
   const usage = { inputTokens: 0, outputTokens: 0 };
   const phaseUsage = { inputTokens: 0, outputTokens: 0 };
   ```

2. The existing `onTokenUsage` callback accumulates into both `usage` (total) and `phaseUsage` (current phase).

3. On each `onPhase` transition (when completing a phase), emit `investigation:phase_usage` with `phaseUsage` values and the phase's duration, then reset `phaseUsage` to zeros.

4. After `investigation:complete`, emit `investigation:total_usage` with `usage` totals and overall duration. Persist totals to DB.

### Chat Token Tracking

1. Record start time when chat request is received.
2. The existing `onTokenUsage` callback accumulates tokens during the response.
3. After `chat:stream_end`, emit `chat:usage` with accumulated tokens and `Date.now() - startTime`.

### No Workflow Step Changes

The workflow steps already emit `onTokenUsage` via `onStepFinish` (anomaly, planning, evidence) and `agent.generate()` results (planning, synthesis). The `ws-handler.ts` is the only backend file that needs changes.

## Database Schema Changes

Add three columns to the `investigations` table:

```sql
ALTER TABLE investigations ADD COLUMN total_input_tokens INTEGER DEFAULT 0;
ALTER TABLE investigations ADD COLUMN total_output_tokens INTEGER DEFAULT 0;
ALTER TABLE investigations ADD COLUMN total_duration_ms INTEGER DEFAULT 0;
```

Applied in `db.ts` init, same pattern as existing schema setup (additive migration with `ALTER TABLE` wrapped in try/catch for idempotency).

Populated when `investigation:complete` fires, from the accumulated totals.

Historical investigation views read these columns to show the total summary bar.

## Files Changed

### Backend
- `src/types/ws-types.ts` — add 3 new ServerMessage types, extend `investigation:tool_call`
- `src/server/ws-handler.ts` — accumulate tokens, emit new WS events, persist totals
- `src/server/db.ts` — add 3 columns to investigations table

### Frontend
- `src/web/components/PhaseStepper.tsx` — add token count to phase stats badge
- `src/web/components/RcaReport.tsx` or `InvestigationPane.tsx` — add total summary bar
- `src/web/components/ChatPane.tsx` — add per-message usage + session footer
- `src/web/lib/formatTokens.ts` (new) — shared compact token formatter

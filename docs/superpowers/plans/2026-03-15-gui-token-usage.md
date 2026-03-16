# GUI Token & Timing Display — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display token usage and timing in the web GUI for investigation phases, chat messages, and investigation totals.

**Architecture:** Add 3 new WebSocket message types (`investigation:phase_usage`, `investigation:total_usage`, `chat:usage`) to the protocol. Backend accumulates tokens via `onTokenUsage` callbacks already wired in Mastra adapters. Frontend renders token badges in PhaseStepper stats, a total summary bar below RCA reports, per-message usage in chat, and a session footer.

**Tech Stack:** TypeScript, React, WebSocket, SQLite (better-sqlite3), Vitest

**Spec:** `docs/superpowers/specs/2026-03-15-gui-token-usage-design.md`

---

## Chunk 1: Backend — Protocol, DB, WebSocket Handler

### Task 1: WebSocket Protocol Types

**Files:**
- Modify: `src/types/ws-types.ts`

- [ ] **Step 1: Add 3 new message types to `ServerMessage` union**

Add these types to the `ServerMessage` union in `ws-types.ts`. The existing union uses `|` separated type literals. Add after the last existing type:

```typescript
| { type: "investigation:phase_usage"; investigationId: string; phase: string; inputTokens: number; outputTokens: number; durationMs: number }
| { type: "investigation:total_usage"; investigationId: string; inputTokens: number; outputTokens: number; durationMs: number }
| { type: "chat:usage"; inputTokens: number; outputTokens: number; durationMs: number }
```

- [ ] **Step 2: Verify type check**

Run: `npx tsc --noEmit`
Expected: No new errors from this file

- [ ] **Step 3: Commit**

```bash
git add src/types/ws-types.ts
git commit -m "feat(ws): add token usage message types to ServerMessage union"
```

---

### Task 2: Database Schema — Token Columns

**Files:**
- Modify: `src/server/db.ts`

- [ ] **Step 1: Add columns to investigations table**

In `db.ts`, find the schema initialization section (after the `CREATE TABLE` statements, there are existing `ALTER TABLE` migrations wrapped in try/catch). Add after the last migration:

```typescript
try { this.db.exec("ALTER TABLE investigations ADD COLUMN total_input_tokens INTEGER DEFAULT 0"); } catch {}
try { this.db.exec("ALTER TABLE investigations ADD COLUMN total_output_tokens INTEGER DEFAULT 0"); } catch {}
try { this.db.exec("ALTER TABLE investigations ADD COLUMN total_duration_ms INTEGER DEFAULT 0"); } catch {}
```

- [ ] **Step 2: Extend `InvestigationRow` interface**

Add to the `InvestigationRow` interface:

```typescript
total_input_tokens: number;
total_output_tokens: number;
total_duration_ms: number;
```

- [ ] **Step 3: Extend `updateInvestigation` method**

Add handling for the three new columns in the `updateInvestigation` method, following the same pattern as existing fields:

```typescript
if (updates.total_input_tokens !== undefined) { sets.push("total_input_tokens = ?"); vals.push(updates.total_input_tokens); }
if (updates.total_output_tokens !== undefined) { sets.push("total_output_tokens = ?"); vals.push(updates.total_output_tokens); }
if (updates.total_duration_ms !== undefined) { sets.push("total_duration_ms = ?"); vals.push(updates.total_duration_ms); }
```

And add the fields to the method's `updates` parameter type:

```typescript
updates: {
  status?: string;
  report?: string;
  completed_at?: string;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_duration_ms?: number;
}
```

- [ ] **Step 4: Verify type check and existing tests**

Run: `npx tsc --noEmit && npx vitest run src/server/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts
git commit -m "feat(db): add token usage columns to investigations table"
```

---

### Task 3: Wire Token Tracking in ws-handler.ts

This is the core backend task. Two paths: investigation and chat.

**Files:**
- Modify: `src/server/ws-handler.ts`

- [ ] **Step 1: Add token accumulator for investigation path**

In ws-handler.ts, find where the investigation is started (around line 349-351 where `phaseStats` is created). Add token accumulators alongside:

```typescript
// Alongside existing:
// const phaseStats = new Map<string, { toolCalls: number; iterations: number; startMs: number }>();

// Add:
const totalTokens = { inputTokens: 0, outputTokens: 0 };
const phaseTokens = { inputTokens: 0, outputTokens: 0 };
const investigationStartMs = Date.now();
```

- [ ] **Step 2: Create onTokenUsage callback and pass to investigate()**

Find the `investigationAgent.investigate()` call (around line 360). The current 4th argument is `undefined` (the `onTokenUsage` slot). Replace with a lambda:

```typescript
const onTokenUsage = (u: { inputTokens: number; outputTokens: number }) => {
  totalTokens.inputTokens += u.inputTokens;
  totalTokens.outputTokens += u.outputTokens;
  phaseTokens.inputTokens += u.inputTokens;
  phaseTokens.outputTokens += u.outputTokens;
};

// Pass as 4th arg (replacing undefined):
investigationAgent.investigate(service, undefined, invId, onTokenUsage, msg.message, ...
```

- [ ] **Step 3: Emit `investigation:phase_usage` on phase completion**

In the `onPhase` callback, find where `investigation:phase` with `status: "complete"` is emitted (around line 382-387). After emitting the phase complete message, emit phase usage and reset:

```typescript
// After: emit({ type: "investigation:phase", phase: prev, status: "complete", stats: ... });
// Add:
emit({
  type: "investigation:phase_usage",
  investigationId: invId,
  phase: prev,
  inputTokens: phaseTokens.inputTokens,
  outputTokens: phaseTokens.outputTokens,
  durationMs,
});
phaseTokens.inputTokens = 0;
phaseTokens.outputTokens = 0;
```

Note: `prev` is already the frontend phase name (from `mapBackendPhase()`). `durationMs` is already computed in the existing code.

- [ ] **Step 4: Emit `investigation:total_usage` after completion and persist to DB**

Find where `investigation:complete` is emitted (around line 421). After it, emit total usage and persist:

```typescript
// After: emit({ type: "investigation:complete", id: invId, report });
// Add:
const totalDurationMs = Date.now() - investigationStartMs;
emit({
  type: "investigation:total_usage",
  investigationId: invId,
  inputTokens: totalTokens.inputTokens,
  outputTokens: totalTokens.outputTokens,
  durationMs: totalDurationMs,
});

db.updateInvestigation(invId, {
  total_input_tokens: totalTokens.inputTokens,
  total_output_tokens: totalTokens.outputTokens,
  total_duration_ms: totalDurationMs,
});
```

Do NOT emit `investigation:total_usage` in the failure path (`investigation:failed`).

- [ ] **Step 5: Add token tracking for conversational chat path**

Find where `agent.chat()` is called for conversational mode (around line 456). Add accumulator and pass `onTokenUsage`:

```typescript
// Before the agent.chat() call:
const chatTokens = { inputTokens: 0, outputTokens: 0 };
const chatStartMs = Date.now();

// Add onTokenUsage to the ChatRequest object:
onTokenUsage: (u) => {
  chatTokens.inputTokens += u.inputTokens;
  chatTokens.outputTokens += u.outputTokens;
},
```

- [ ] **Step 6: Emit `chat:usage` after `chat:stream_end`**

Find where `chat:stream_end` is emitted (around line 489). After it, emit chat usage:

```typescript
// After: send({ type: "chat:stream_end", content, ... });
// Add:
send({
  type: "chat:usage",
  inputTokens: chatTokens.inputTokens,
  outputTokens: chatTokens.outputTokens,
  durationMs: Date.now() - chatStartMs,
});
```

- [ ] **Step 7: Do the same for deep-investigate chat path**

Find the `handleDeepInvestigate` function (around line 252). Apply the same pattern: add `chatTokens` accumulator, pass `onTokenUsage` to `agent.chat()`, emit `chat:usage` after `chat:stream_end`.

- [ ] **Step 8: Verify type check**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 9: Commit**

```bash
git add src/server/ws-handler.ts
git commit -m "feat(ws): emit token usage events for investigation and chat"
```

---

### Task 4: REST API — Expose Token Columns

**Files:**
- Modify: `src/server/routes.ts` (if needed)

- [ ] **Step 1: Verify the `/api/investigations/:id` endpoint already returns full InvestigationRow**

The endpoint returns `db.getInvestigation(id)` which returns the full row. Since we added the columns to `InvestigationRow`, they should already be included in the response. Verify by reading the code — if `getInvestigation` does `SELECT *`, the new columns are automatically included.

If the query uses explicit column names, add the three new columns to the SELECT.

- [ ] **Step 2: Verify type check**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit if changes needed**

```bash
git add src/server/routes.ts
git commit -m "feat(api): include token usage in investigation response"
```

---

## Chunk 2: Frontend — Token Formatter, PhaseStepper, Investigation Summary

### Task 5: Token Formatter Utility

**Files:**
- Create: `src/web/lib/formatTokens.ts`
- Create: `src/web/lib/formatTokens.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/web/lib/formatTokens.test.ts
import { describe, it, expect } from "vitest";
import { formatTokens } from "./formatTokens.js";

describe("formatTokens", () => {
  it("returns literal number for < 1000", () => {
    expect(formatTokens(892)).toBe("892");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(18200)).toBe("18.2k");
    expect(formatTokens(54717)).toBe("54.7k");
    expect(formatTokens(999999)).toBe("1000.0k");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(1234567)).toBe("1.2M");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/lib/formatTokens.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement formatTokens**

```typescript
// src/web/lib/formatTokens.ts
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/web/lib/formatTokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/formatTokens.ts src/web/lib/formatTokens.test.ts
git commit -m "feat(web): add compact token formatter utility"
```

---

### Task 6: PhaseStepper — Token Badge

**Files:**
- Modify: `src/web/components/PhaseStepper.tsx`

- [ ] **Step 1: Add `phaseTokens` prop**

Add a new prop to PhaseStepper's props type:

```typescript
phaseTokens?: Record<string, { inputTokens: number; outputTokens: number }>;
```

- [ ] **Step 2: Import formatTokens and render token badge**

Import `formatTokens` from `../lib/formatTokens.js`.

In the stats badges section (around line 233-244), after the duration badge, add a token badge:

```typescript
{phaseTokens?.[phase.name] && (
  <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-secondary/30 text-muted-foreground/35 border border-border/15">
    {formatTokens(
      (phaseTokens[phase.name]?.inputTokens ?? 0) + (phaseTokens[phase.name]?.outputTokens ?? 0)
    )} tok
  </span>
)}
```

- [ ] **Step 3: Verify type check**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/web/components/PhaseStepper.tsx
git commit -m "feat(web): add token badge to PhaseStepper phase stats"
```

---

### Task 7: InvestigationPane — Phase Tokens State + Total Summary Bar

**Files:**
- Modify: `src/web/components/InvestigationPane.tsx`

- [ ] **Step 1: Add phaseTokens and totalUsage state**

Add state for tracking phase-level and total token usage:

```typescript
const [phaseTokens, setPhaseTokens] = useState<Record<string, { inputTokens: number; outputTokens: number }>>({});
const [totalUsage, setTotalUsage] = useState<{ inputTokens: number; outputTokens: number; durationMs: number } | null>(null);
```

- [ ] **Step 2: Handle new WS message types**

In the WS message processing loop (around line 145), add handlers for the new message types:

```typescript
if (msg.type === "investigation:phase_usage" && msg.investigationId === investigationId) {
  setPhaseTokens((prev) => ({
    ...prev,
    [msg.phase]: { inputTokens: msg.inputTokens, outputTokens: msg.outputTokens },
  }));
}

if (msg.type === "investigation:total_usage" && msg.investigationId === investigationId) {
  setTotalUsage({ inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, durationMs: msg.durationMs });
}
```

- [ ] **Step 3: Pass phaseTokens to PhaseStepper**

Find where `<PhaseStepper>` is rendered (around line 292). Add the prop:

```typescript
<PhaseStepper phases={phases} events={timelineEvents} evidence={evidence} isComplete={isComplete} phaseTokens={phaseTokens} />
```

- [ ] **Step 4: Render total summary bar below RcaReport**

After the `<RcaReport>` component render, add the total summary bar:

```typescript
{totalUsage && (
  <div className="flex items-center gap-2 px-4 py-2 text-[10px] font-mono text-muted-foreground/50 border-t border-border/20">
    <span>Total:</span>
    <span>{formatTokens(totalUsage.inputTokens)} input</span>
    <span>·</span>
    <span>{formatTokens(totalUsage.outputTokens)} output</span>
    <span>·</span>
    <span>{formatTokens(totalUsage.inputTokens + totalUsage.outputTokens)} tokens</span>
    <span>·</span>
    <span>{(totalUsage.durationMs / 1000).toFixed(1)}s</span>
  </div>
)}
```

- [ ] **Step 5: Load totals from DB for historical investigations**

In the historical investigation loading code (where `/api/investigations/:id` response is processed), extract the token columns:

```typescript
if (data.investigation.total_input_tokens > 0) {
  setTotalUsage({
    inputTokens: data.investigation.total_input_tokens,
    outputTokens: data.investigation.total_output_tokens,
    durationMs: data.investigation.total_duration_ms,
  });
}
```

- [ ] **Step 6: Import formatTokens**

Add import at top:
```typescript
import { formatTokens } from "../lib/formatTokens.js";
```

- [ ] **Step 7: Verify type check**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 8: Commit**

```bash
git add src/web/components/InvestigationPane.tsx
git commit -m "feat(web): add phase token tracking and total summary bar to investigation view"
```

---

## Chunk 3: Frontend — Chat Token Display

### Task 8: ChatPane — Per-Message Usage + Session Footer

**Files:**
- Modify: `src/web/components/ChatPane.tsx`

- [ ] **Step 1: Add tokenUsage to ChatMessage interface**

Extend the `ChatMessage` interface (around line 20-27):

```typescript
tokenUsage?: { inputTokens: number; outputTokens: number; durationMs: number };
```

- [ ] **Step 2: Add session usage state**

Add state for session-level accumulation:

```typescript
const [sessionTokens, setSessionTokens] = useState({ inputTokens: 0, outputTokens: 0, messageCount: 0 });
```

Reset on `session_cleared`:
```typescript
// In the existing session_cleared handler:
setSessionTokens({ inputTokens: 0, outputTokens: 0, messageCount: 0 });
```

- [ ] **Step 3: Handle `chat:usage` message**

In the WS message processing, after the `chat:stream_end` handler, add:

```typescript
if (msg.type === "chat:usage") {
  const usage = { inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, durationMs: msg.durationMs };

  // Attach usage to the last assistant message
  const updateMessages = (prev: ChatMessage[]) => {
    if (prev.length === 0) return prev;
    const last = prev[prev.length - 1]!;
    if (last.role !== "assistant") return prev;
    return [...prev.slice(0, -1), { ...last, tokenUsage: usage }];
  };

  if (isDeepMode) {
    setDeepMessages(updateMessages);
  } else {
    setChatMessages(updateMessages);
  }

  setSessionTokens((prev) => ({
    inputTokens: prev.inputTokens + msg.inputTokens,
    outputTokens: prev.outputTokens + msg.outputTokens,
    messageCount: prev.messageCount + 1,
  }));
}
```

- [ ] **Step 4: Render per-message usage below assistant messages**

In the message rendering loop (around line 436-461), after the assistant message content and skills badges, add:

```typescript
{message.tokenUsage && (
  <div className="text-[10px] font-mono text-muted-foreground/40 mt-1">
    {formatTokens(message.tokenUsage.inputTokens + message.tokenUsage.outputTokens)} tokens · {(message.tokenUsage.durationMs / 1000).toFixed(1)}s
  </div>
)}
```

- [ ] **Step 5: Render session footer**

After the message scroll area and before the input box, add a footer:

```typescript
{sessionTokens.messageCount > 0 && (
  <div className="flex items-center gap-2 px-4 py-1.5 text-[10px] font-mono text-muted-foreground/40 border-t border-border/20 bg-background/80">
    <span>This session:</span>
    <span>{formatTokens(sessionTokens.inputTokens + sessionTokens.outputTokens)} tokens</span>
    <span>·</span>
    <span>{sessionTokens.messageCount} messages</span>
  </div>
)}
```

- [ ] **Step 6: Import formatTokens**

Add import at top:
```typescript
import { formatTokens } from "../lib/formatTokens.js";
```

- [ ] **Step 7: Verify type check**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 8: Commit**

```bash
git add src/web/components/ChatPane.tsx
git commit -m "feat(web): add per-message token usage and session footer to chat"
```

---

### Task 9: Build and Verify

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Build frontend**

Run: `npm run build:web`
Expected: Vite build succeeds

- [ ] **Step 4: Commit if any fixes needed**

---

## Summary

| Task | Component | Files | Change |
|------|-----------|-------|--------|
| 1 | WS types | `ws-types.ts` | Add 3 new ServerMessage types |
| 2 | DB schema | `db.ts` | Add 3 columns, extend updateInvestigation |
| 3 | WS handler | `ws-handler.ts` | Wire onTokenUsage, emit events, persist |
| 4 | REST API | `routes.ts` | Verify token columns in response |
| 5 | Formatter | `formatTokens.ts` (new) | Compact token formatting (892, 18.2k, 1.2M) |
| 6 | PhaseStepper | `PhaseStepper.tsx` | Token badge in phase stats |
| 7 | Investigation | `InvestigationPane.tsx` | Phase tokens state + total summary bar |
| 8 | Chat | `ChatPane.tsx` | Per-message usage + session footer |
| 9 | Verification | — | Tests, type check, build |

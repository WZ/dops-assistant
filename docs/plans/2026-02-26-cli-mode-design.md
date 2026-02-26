# CLI Mode Design

## Problem

Testing and interacting with the agent requires Slack. A CLI mode lets you interact directly from the terminal — same conversational and investigation capabilities, faster iteration, no Slack dependency.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Entry point | Separate `npm run cli` command | Doesn't interfere with existing Slack+scheduler flow |
| Scope | Conversational + investigation (intent routing) | Full feature parity with Slack bot |
| UI framework | Ink (React for terminals) | Rich UX: spinners, tool call log, bordered boxes |
| Image handling | Save to /tmp + open on macOS | Quick feedback loop for chart screenshots |
| Streaming | Not in v1 | Would require LLM client changes; spinner + tool log is sufficient |

## UX

```
$ npm run cli

  dops-assistant v0.1.0
  Connected to Grafana MCP (23 tools available)

> what's the error rate for payments-api?

  ⠋ Thinking...
  ◼ query_prometheus({ expr: "rate(errors[5m])" })
  ◼ get_panel_image({ dashboardUid: "abc", panelId: 3 })

  The current error rate for payments-api is 0.3%, within normal range.
  📎 Saved: /tmp/dops-get_panel_image-a1b2c3d4.png (opened)

> investigate payments-api

  ⠋ Running investigation...
  Phase 2: Metric deep dive ✓ | Log correlation ✓ | Infra health ✓

  ╭─ RCA Report: payments-api ──────────────────────╮
  │ Severity: high | Confidence: high                │
  │ Root cause: DB connection pool exhausted          │
  │ Actions: Scale connection pool, Add circuit...    │
  ╰──────────────────────────────────────────────────╯

> exit
```

Special commands: `exit`/`quit` (shutdown), `clear` (reset conversation).

## Architecture

```
src/cli.tsx                    — entry point, wires components, renders <App>
src/interfaces/cli/
  App.tsx                      — root component: state, input handling, agent dispatch
  MessageList.tsx              — renders conversation messages
  InputPrompt.tsx              — text input with > prompt
  ToolCallLog.tsx              — real-time tool call display
  RcaReportBox.tsx             — bordered RCA report output
```

### AgentCore change

Add optional `onToolCall` callback to `AgentTask`:

```ts
type AgentTask = {
  mode: AgentMode;
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
  correlationId?: string;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
};
```

Called before each tool execution. Backward-compatible — Slack bot doesn't pass it.

### Data flow

1. User types message in `InputPrompt`
2. `App` classifies intent (IntentClassifier)
3. Route to `AgentCore.run()` or `InvestigationAgent.investigate()`
4. During agent loop: `onToolCall` callback updates `ToolCallLog` in real-time
5. On completion: response added to `MessageList`, images saved and opened
6. Conversation memory persists across turns

### Image handling

- `AgentResult.images` → save each to `/tmp/dops-{filename}`
- On macOS: use `execFile("open", [path])` (via `child_process.execFile`, not `exec`, to avoid shell injection)
- Print `📎 Saved: /path (opened)` after the response

### RCA output

`RcaReportBox` renders `RcaReport` with Ink's `<Box borderStyle="round">`:
- Header: service name + severity emoji
- Root cause, evidence summary, recommended actions
- Confidence + timestamp footer

## Dependencies

New runtime deps:
- `ink` — React renderer for terminals
- `react` — required by Ink
- `ink-text-input` — text input component

New dev deps:
- `@types/react` — TypeScript types

## npm scripts

```json
"cli": "tsx src/cli.tsx"
```

## Config

No config schema changes. CLI reuses the same `config.yaml`. Slack and scheduler sections are ignored when running in CLI mode.

## Error handling

- MCP connection failure → print error, exit with code 1
- LLM timeout → print "Request timed out, please try again", return to prompt
- Tool errors → shown inline as `[Tool Error] ...` (same as Slack)
- Ctrl+C → graceful shutdown (disconnect MCP, exit cleanly)

## Out of scope

- Token streaming (requires LLM client refactor)
- Config file generation wizard
- Multi-session/tab support

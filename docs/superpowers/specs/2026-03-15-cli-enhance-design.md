# CLI Enhancement: Programmatic Validation & Benchmark Interface

**Date:** 2026-03-15
**Branch:** `feature/cli-enhance` (from `worktree-mastra-refactor`)
**Status:** Approved

## Motivation

The web GUI is the primary user-facing interface. The CLI should be repurposed as a programmatic validation and benchmark tool that AI agents (e.g., Claude Code, Codex) can invoke to validate changes to agent logic, prompts, and MCP integrations. Each invocation runs a single command, prints structured JSON to stdout, and exits.

## Command Structure

```
dops investigate <service>    # Run RCA investigation, output JSON
dops chat "<message>"         # Send a message to chat agent, output JSON
dops mcp-check               # Verify MCP connectivity and tool availability
dops e2e <scenario-file>     # Run predefined test scenario, output JSON
dops interactive              # Legacy REPL mode (preserved)
```

### Common Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--timeout <ms>` | Max execution time | `120000` |
| `--verbose` | Include full tool call args and results in output | `false` |
| `--config <path>` | Path to config file | `config.yaml` (also accepts `CONFIG_PATH` env var) |
| `--no-history` | Disable reading/writing incident history | `true` for non-interactive commands |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Failure (agent error, MCP unreachable, assertion failed) |
| `2` | Invalid usage (bad args, missing service) |

## JSON Output Schemas

All output is JSON to stdout. Logs (pino) go to stderr. All field names use **camelCase** to match the TypeScript types directly — `RcaReport`, agent interfaces, etc. are passed through as-is with no case conversion.

### `dops investigate <service>`

Service name is matched **exactly (case-insensitive)** against `config.services[].name`. No LLM-based fuzzy matching — deterministic resolution for benchmark reliability.

```json
{
  "command": "investigate",
  "service": "api-gateway",
  "status": "success | error",
  "durationMs": 14230,
  "tokens": { "input": 12000, "output": 3400, "total": 15400 } | null,
  "toolCalls": [
    { "name": "search_dashboards", "argsSummary": "query=api-gateway", "durationMs": 340 }
  ],
  "history": false,
  "result": {
    "service": "api-gateway",
    "severity": "high",
    "confidence": "high",
    "confidenceScore": 0.85,
    "summary": "...",
    "trigger": "...",
    "rootCause": "...",
    "impact": { "duration": "30m", "description": "..." },
    "contributingFactors": ["..."],
    "timeline": [{ "time": "14:30", "event": "CPU spike detected" }],
    "evidence": {
      "metrics": ["..."],
      "logs": ["..."],
      "infra": ["..."]
    },
    "dashboardLinks": ["..."],
    "recommendedActions": ["..."],
    "investigatedAt": "2026-03-15T14:35:00Z"
  },
  "error": null
}
```

The `result` field is the `RcaReport` type from `src/types/rca-types.ts` serialized directly.

**Token usage:** The current adapters (`MastraChatAgentAdapter`, `MastraInvestigationAdapter`) do not wire up `onTokenUsage` callbacks. Implementation must add token tracking by hooking into the Mastra agent/workflow `onStepFinish` events or the underlying AI SDK `usage` property on generation results. If token data is unavailable, `tokens` is set to `null` (not zeros) to avoid fabricating data.

### `dops chat "<message>"`

Single-turn only. No conversation history is maintained between invocations. The agent receives only the provided message.

```json
{
  "command": "chat",
  "message": "What alerts fired in the last hour?",
  "status": "success | error",
  "durationMs": 3200,
  "tokens": { "input": 800, "output": 600, "total": 1400 } | null,
  "toolCalls": [
    { "name": "list_alerts", "argsSummary": "state=firing", "durationMs": 520 }
  ],
  "result": {
    "response": "..."
  },
  "error": null
}
```

The `toolCalls` array is populated when the chat agent uses MCP tools during its response.

### `dops mcp-check`

```json
{
  "command": "mcp-check",
  "status": "success | error",
  "durationMs": 1200,
  "providers": [
    {
      "name": "grafana-mcp",
      "status": "connected | error",
      "toolsCount": 12,
      "tools": ["search_dashboards", "get_datasource_by_uid"],
      "error": null
    }
  ]
}
```

The `tools` list is always emitted (not gated by `--verbose`). It reports available tool names, not tool call traces.

### `dops e2e <scenario-file>`

```json
{
  "command": "e2e",
  "scenario": "alert-resolution.json",
  "status": "pass | fail",
  "durationMs": 18400,
  "steps": [
    {
      "name": "investigate api-gateway",
      "status": "pass | fail | skipped",
      "durationMs": 14230,
      "error": null,
      "assertions": [
        { "field": "result.severity", "expected": "high", "actual": "high", "pass": true }
      ]
    }
  ]
}
```

### Scenario File Format

Input to `dops e2e`:

```json
{
  "name": "alert-resolution",
  "steps": [
    {
      "command": "investigate",
      "args": { "service": "api-gateway" },
      "assert": {
        "status": "success",
        "result.severity": { "in": ["medium", "high", "critical"] },
        "result.confidenceScore": { "gte": 0.5 },
        "result.evidence.metrics": { "not_empty": true }
      }
    },
    {
      "command": "chat",
      "args": { "message": "What alerts are firing for api-gateway?" },
      "assert": {
        "status": "success",
        "result.response": { "contains": "alert" }
      }
    }
  ]
}
```

#### Assertion Operators

| Operator | Description | Example |
|----------|-------------|---------|
| (literal) | Exact match | `"status": "success"` |
| `in` | Value in set | `{ "in": ["high", "critical"] }` |
| `gte` | Greater than or equal | `{ "gte": 0.5 }` |
| `lte` | Less than or equal | `{ "lte": 100 }` |
| `not_empty` | Array/string is non-empty | `{ "not_empty": true }` |
| `contains` | String contains substring | `{ "contains": "timeout" }` |

#### Step Isolation

Steps share the MCP connection and Mastra agent instances (initialized once per `e2e` run). Conversation state is **not** shared — each step is independent.

**Step status enum:** `"pass" | "fail" | "skipped"`. A step is `"pass"` if all assertions pass, `"fail"` if any assertion fails or the command errors, and `"skipped"` if a prior step caused a fatal error (e.g., MCP connectivity loss). Skipped steps have `error` set to a descriptive message (e.g., `"skipped: MCP connection lost in step 1"`), `durationMs: 0`, and no `assertions` array. The overall e2e status is `"fail"` if any step is not `"pass"`.

## History Isolation

Non-interactive commands (`investigate`, `chat`, `e2e`) run with history **disabled by default** (`--no-history` is `true`). This means:

- The planning step does **not** read prior incidents (skips `history.ts` lookups)
- The post-synthesis step does **not** write new incidents to disk
- Results are deterministic and independent of previous runs

This is critical for benchmark reliability — repeated runs produce consistent results unaffected by accumulated history. Use `--history` to opt in to reading/writing history if needed (e.g., testing the history-aware planning path itself).

The `interactive` subcommand uses history normally (reads and writes).

The `"history"` field in the JSON output indicates whether history was active for that run.

## `--verbose` Flag Behavior

| Field | Default (no flag) | `--verbose` |
|-------|-------------------|-------------|
| `toolCalls[].name` | Included | Included |
| `toolCalls[].argsSummary` | First 80 chars of args | Full args JSON |
| `toolCalls[].durationMs` | Included | Included |
| `toolCalls[].result` | Omitted | Full result (can be large) |
| `toolCalls[].error` | Omitted | Included if present |
| `toolCalls[].phase` | Omitted | Included (investigation phase name) |

Tool `durationMs` is measured by the command layer by timestamping each `tool-call` event and pairing it with the subsequent `tool-result` event. If a pair cannot be matched, `durationMs` is omitted.

## Architecture

### File Structure

```
src/cli/
  index.tsx          → rewrite: arg parser, subcommand dispatch
  commands/
    investigate.ts   → run investigation, return JSON
    chat.ts          → run chat agent, return JSON
    mcp-check.ts     → test MCP connectivity, return JSON
    e2e.ts           → load scenario file, run steps, assert results
    interactive.tsx   → existing REPL (moved from current App.tsx)
  output.ts          → JSON envelope builder (status, duration, tokens, error)
  assertions.ts      → scenario assertion engine (in, gte, not_empty, etc.)
```

### Design Decisions

1. **JSON to stdout, logs to stderr.** The calling agent reads stdout only. Pino logger is configured to write to stderr so it never pollutes parseable output.

2. **Reuse existing agents.** Each command initializes the same Mastra adapters and agents. No duplication. The difference: no Ink rendering, results are captured programmatically.

3. **Timeout wrapper.** Each command runs inside `Promise.race` with a configurable timeout. On timeout: `{ "status": "error", "error": "timeout" }`, exit 1.

4. **Graceful process exit.** After building the JSON result, write it to stdout and wait for the write to drain before exiting. Use `process.exitCode = N` combined with a `stdout.write(json, () => process.exit())` pattern to ensure the full JSON is flushed before the process terminates. This prevents truncated output when consumed by a machine reader. MCP stdio child processes are cleaned up when the Node.js process exits.

5. **Lightweight arg parsing.** Parse `process.argv` directly — the command set is small and fixed. No heavy CLI framework dependency.

6. **`interactive` subcommand.** Preserves the existing Ink REPL as-is for backward compatibility.

### Pino Logger Initialization

Each command module must **dynamically import** all agent/provider modules after `LOG_LEVEL` has been set, using the same pattern as the current `src/cli/index.tsx`:

- Non-interactive commands: set `LOG_LEVEL=info` and configure pino destination to stderr (`fd: 2`)
- `interactive` subcommand: set `LOG_LEVEL=silent` (pino stdout would corrupt Ink rendering)

This ordering matters because ESM hoists static imports. The current CLI solves this with dynamic `import()` calls after setting `LOG_LEVEL` (see `src/cli/index.tsx` lines 5-17). All new command modules follow the same pattern.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Agent failure (LLM timeout, malformed response) | `{ "status": "error", "error": "descriptive message" }`, exit 1 |
| MCP connection failure | Error captured in JSON output, timeout ensures exit |
| Unknown service name | `{ "status": "error", "error": "unknown service: foo" }`, exit 1 |
| Invalid scenario file | Exit 2 with usage error in JSON |
| Partial e2e failure (assertion) | Failed step has `"status": "fail"`, remaining steps still run, overall `"status": "fail"` |
| e2e MCP connectivity failure | Remaining steps have `"status": "skipped"` with error message, overall `"status": "fail"` |
| No signal handling needed | Calling agent can kill the process directly |

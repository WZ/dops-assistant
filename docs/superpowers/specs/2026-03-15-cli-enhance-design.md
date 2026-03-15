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
| `--verbose` | Include raw tool call details in output | `false` |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Failure (agent error, MCP unreachable, assertion failed) |
| `2` | Invalid usage (bad args, missing service) |

## JSON Output Schemas

All output is JSON to stdout. Logs (pino) go to stderr.

### `dops investigate <service>`

```json
{
  "command": "investigate",
  "service": "api-gateway",
  "status": "success | error",
  "duration_ms": 14230,
  "tokens": { "input": 12000, "output": 3400, "total": 15400 },
  "tool_calls": [
    { "name": "search_dashboards", "args_summary": "query=api-gateway", "duration_ms": 340 }
  ],
  "result": {
    "severity": "high",
    "confidence": 0.85,
    "summary": "...",
    "root_cause": "...",
    "evidence": {
      "metrics": [],
      "logs": [],
      "infrastructure": []
    },
    "contributing_factors": [],
    "timeline": [],
    "recommendations": [],
    "dashboard_links": []
  },
  "error": null
}
```

### `dops chat "<message>"`

```json
{
  "command": "chat",
  "message": "What alerts fired in the last hour?",
  "status": "success | error",
  "duration_ms": 3200,
  "tokens": { "input": 800, "output": 600, "total": 1400 },
  "tool_calls": [],
  "result": {
    "response": "..."
  },
  "error": null
}
```

### `dops mcp-check`

```json
{
  "command": "mcp-check",
  "status": "success | error",
  "duration_ms": 1200,
  "providers": [
    {
      "name": "grafana-mcp",
      "status": "connected | error",
      "tools_count": 12,
      "tools": ["search_dashboards", "get_datasource_by_uid"],
      "error": null
    }
  ]
}
```

### `dops e2e <scenario-file>`

```json
{
  "command": "e2e",
  "scenario": "alert-resolution.json",
  "status": "pass | fail",
  "duration_ms": 18400,
  "steps": [
    {
      "name": "investigate api-gateway",
      "status": "pass | fail",
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
        "result.confidence": { "gte": 0.5 },
        "result.evidence.metrics": { "not_empty": true }
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

4. **Clean process exit.** After JSON is printed, `process.exit(0|1|2)` explicitly. No dangling MCP connections or event loops.

5. **Lightweight arg parsing.** Parse `process.argv` directly — the command set is small and fixed. No heavy CLI framework dependency.

6. **`interactive` subcommand.** Preserves the existing Ink REPL as-is for backward compatibility.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Agent failure (LLM timeout, malformed response) | `{ "status": "error", "error": "descriptive message" }`, exit 1 |
| MCP connection failure | Error captured in JSON output, timeout ensures exit |
| Unknown service name | `{ "status": "error", "error": "unknown service: foo" }`, exit 1 |
| Invalid scenario file | Exit 2 with usage error in JSON |
| Partial e2e failure | Results for all steps included, overall `"status": "fail"` |
| No signal handling needed | Calling agent can kill the process directly |

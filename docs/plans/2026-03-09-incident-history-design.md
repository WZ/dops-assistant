# Incident History & Change Event Integration

## Context

Inspired by Microsoft's RCACopilot paper (EuroSys'24), which found that 93.8% of recurring cloud incidents reappear within 20 days. Their system achieves significant RCA accuracy gains by using similar past incidents as few-shot examples for LLM reasoning.

Currently, dops-assistant treats every investigation as independent — no memory of past incidents. Adding lightweight incident history to the planning phase would help the LLM form better hypotheses for recurring issues.

## Part 1: Incident History (build now)

### Storage

- Path: `.dops/incidents/{service}/{timestamp}.json`
- Timestamp format: ISO 8601 sanitized for filenames (e.g., `2026-03-09T14-30-00Z.json`)
- `.dops/` added to `.gitignore` if not already present

### Slim Record Schema

Store only fields useful for future planning — skip heavy fields like `panelImages`, `evidence`, `timeline`, `dashboardLinks`:

```typescript
type IncidentRecord = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  rootCause: string;
  trigger: string;
  confidence: "low" | "medium" | "high";
  investigatedAt: string;
};
```

### Write Behavior

- After `investigate()` returns the `RcaReport`, extract the slim record and write to disk.
- Skip saving if severity is `low` (no-anomaly results add noise for future investigations).
- On write, prune old files for that service: delete any older than 30 days or beyond 10-file cap (oldest first).

### Read Behavior

- Before Phase 1.5, glob `.dops/incidents/{service}/*.json`.
- Parse each file, filter out records older than 30 days.
- Sort by recency, take up to 10 (retention cap), inject the 5 most recent into the planning prompt.

### Retention Policy

- Max 10 incidents per service
- Max 30 days age
- Whichever limit hits first; pruning runs on every write

### Planning Prompt Injection

Injected into the Phase 1.5 planning message, after anomaly details:

```
Recent incidents for this service (last 30 days):
- 3 days ago [high] UDP ports exhausted on front-door machine (root cause: no port recycling configured)
- 8 days ago [medium] Messages queued beyond limit (root cause: config service failed to update)

Consider whether the current anomaly is a recurrence or related to a previous root cause.
```

### Prompt Update

Add to `INVESTIGATION_PLAN_PROMPT`:

> If recent incidents are provided, consider whether the current anomaly is a recurrence or shares a root cause with a previous incident.

### New Module

`src/history/store.ts` — exports:
- `saveIncident(projectRoot, report)` — extract slim record, write JSON, prune
- `getRecentIncidents(projectRoot, service)` — glob, parse, filter, sort, return up to 5
- `pruneIncidents(projectRoot, service)` — delete files beyond age/count limits

### Testing

Unit tests for save/read/prune logic using a temp directory. No integration with LLM needed — pure filesystem operations.

## Part 2: Change Event Integration (plan only, build later)

### Goal

Give the investigation pipeline visibility into "what changed" around the incident window. Most real incidents are caused by recent deployments or configuration changes.

### Approach

1. Add `changes` to `ProviderRoleSchema` (alongside `metrics`, `logs`, `dashboards`, `dependencies`).
2. A Kubernetes MCP provider with `roles: [dependencies, changes]` would expose deployment/rollout history, pod scaling events, ConfigMap changes.
3. During Phase 1.5 pre-fetch: if any provider has `changes` role, query for recent deployments/changes within the investigation time window.
4. Inject into planning prompt: "Recent changes: deployment of api-gateway v2.3.1 at 13:58 UTC (2 minutes before anomaly)"

### What K8s MCP Gives Us (~60-70% of change event value)

- Deployment rollout history and timestamps
- ConfigMap/Secret change metadata
- HPA scaling events
- Pod restart/OOMKill events (partially covered by Phase 4 already)

### What It Doesn't Cover (future work)

- Git commit context (what code changed)
- Feature flag flips
- Infrastructure-as-code changes (Terraform/Helm values)
- External dependency changes

### No Code Changes Now

This section captures the design direction only. Implementation deferred until a K8s or deployment-aware MCP provider is available.

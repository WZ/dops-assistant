# Agent-Driven Service Discovery

## Problem

Manually composing `services:` entries in config.yaml is tedious. Users must know their Prometheus metric names, label conventions, and Loki label schemas. This information already exists in the monitoring stack and can be discovered automatically.

## Solution

Use the LLM agent with existing Grafana MCP tools to probe Prometheus and Loki, discover services, and generate `ServiceConfig[]` automatically.

## Architecture

A `DiscoveryAgent` class runs through the existing `AgentCore` loop with a discovery-specific system prompt. It uses MCP tools (`query_prometheus`, Loki queries) to enumerate services and find their metrics/logs.

### Two entry points

1. **`npm run discover`** — interactive CLI. Runs discovery, shows results, user confirms, writes to config.yaml.
2. **Startup auto-refresh** — optional `discovery.autoRefresh: true`. Runs discovery silently on startup and merges with static config (static entries take precedence).

### Discovery flow

```
DiscoveryAgent.discover()
  1. Query consul_catalog_service_node_healthy -> extract service names
  2. Per service: probe Prometheus for metrics
     - Try {job="name"}, {service="name"}, other label patterns
     - Select useful RED metrics (rate, errors, latency)
     - Write PromQL queries with descriptions
  3. Query Loki label values, match against service names
     - Try {app="name"}, {service="name"}, etc.
  4. Return ServiceConfig[] as structured JSON
```

The LLM decides probe strategy per service — no hardcoded heuristics. This handles environments with varying label conventions.

## Config changes

New `discovery` section in config schema:

```yaml
discovery:
  autoRefresh: false
  excludeServices:
    - consul
    - prometheus
    - grafana
  consulMetric: "consul_catalog_service_node_healthy"
```

- `autoRefresh` — run discovery on startup and merge with static services
- `excludeServices` — skip infrastructure services during discovery
- `consulMetric` — Prometheus metric used to enumerate services

Static `services:` entries always take precedence over discovered ones.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/agent/discovery.ts` | Create | DiscoveryAgent class + discovery prompt + response schema |
| `src/discover.tsx` | Create | CLI entry point for `npm run discover` |
| `src/config/schema.ts` | Modify | Add DiscoveryConfig to Zod schema |
| `src/config/loader.ts` | Modify | Handle discovery config defaults |
| `src/index.ts` | Modify | Auto-refresh on startup if enabled |
| `package.json` | Modify | Add `discover` script |

## Discovery prompt strategy

The system prompt instructs the agent to:
1. Query the Consul metric to get service names
2. For each service, use query_prometheus to find metrics by trying common label patterns
3. Pick the most useful metrics (RED signals) and write PromQL queries with descriptions
4. Query Loki labels to find matching log streams
5. Return ServiceConfig[] matching the schema

Response format enforced via Zod schema + structured output (same pattern as AnomalyAssessment).

## Merge strategy

On both CLI and startup refresh:
1. Load static services from config.yaml
2. Run discovery agent -> get discovered ServiceConfig[]
3. For each discovered service: skip if name matches a static entry
4. Append remaining discovered services to the list

CLI additionally writes the merged result back to config.yaml.

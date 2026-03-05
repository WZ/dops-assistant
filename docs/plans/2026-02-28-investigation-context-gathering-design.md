# Investigation Context-Gathering Pre-Phase Design

**Date**: 2026-02-28
**Status**: Approved

## Problem

The investigation agent (RCA pipeline) produces poor results because:
1. It doesn't know datasource UIDs upfront — wastes iterations discovering them.
2. It doesn't know which Loki labels match a service — guesses wrong or skips logs entirely.
3. It treats all services the same — bare-metal consul services and K8s pods get identical prompts, leading to wasted tool calls on data that doesn't exist.

## Approach: Context-Gathering Pre-Phase (Phase 0)

Add a programmatic pre-phase that gathers environment and service context **before** the LLM-driven investigation phases begin. This context is injected into phase prompts so the LLM starts with the right datasource UIDs, Loki labels, and service classification.

## Design

### Phase 0 — EnvironmentContext (`src/agent/env-context.ts`)

Cached per-process, gathered once on first investigation:

```typescript
type EnvironmentContext = {
  prometheusDatasourceUid: string;
  lokiDatasourceUid: string;
  lokiLabelKeys: string[]; // e.g. ["app_fortidata_name", "job", "container_name"]
};
```

**How it works:**
1. Call `list_datasources` MCP tool → extract Prometheus and Loki UIDs.
2. Call Loki `query_loki` with `{job=~".+"}` limit 1 → extract available label keys from the response.
3. Cache the result — datasource UIDs and label conventions don't change during a process lifetime.

No LLM calls. Pure programmatic parsing of MCP tool responses.

### LokiResolver (`src/agent/loki-resolver.ts`)

Per-investigation, resolves which Loki label selector matches a given service name.

**Cascade (try in order, stop on first hit):**
1. `{app_fortidata_name="<service-name>"}` limit 1
2. `{app_fortidata_name="<stem>"}` limit 1 (strip `-server`, `-tserver`, etc.)
3. `{job=~".*/<service-name>"}` limit 1
4. `{job=~".*/<stem>"}` limit 1
5. `{container_name="<service-name>"}` limit 1

Each step is a single MCP `query_loki` call. Returns the matching label selector or `null` if no match after all steps.

### ServiceClassifier (`src/agent/service-classifier.ts`)

Classifies a service based on the LokiResolver result:

```typescript
type ServiceContext = {
  classification: "full" | "metrics-only";
  lokiSelector: Record<string, string> | null; // e.g. {"app_fortidata_name": "kudu"}
  envContext: EnvironmentContext;
};
```

- `full`: Loki logs found — run all 5 phases (metrics + logs + correlation).
- `metrics-only`: No Loki logs — skip log-dependent phases, focus on Prometheus metrics and consul health.

### Phase Prompt Changes (`src/agent/rca-prompts.ts`)

Phase prompt functions gain an optional `context?: ServiceContext` parameter:
- Inject datasource UIDs directly into prompts (no more "call list_datasources first").
- Inject Loki selector (no more guessing labels).
- For `metrics-only` services, shorten/skip log-analysis phases.

Existing call signatures are preserved — `context` defaults to `undefined` and prompts fall back to current behavior.

### Investigation Flow (`src/agent/investigation.ts`)

```
investigate(service)
  │
  ├─ Phase 0: EnvironmentContext (cached, programmatic)
  ├─ Phase 0: LokiResolver.resolve(service.name) (programmatic)
  ├─ Phase 0: ServiceClassifier.classify(lokiResult)
  │
  ├─ Phase 1: Triage (with injected context)
  ├─ Phase 2: Deep-dive (with injected context)
  ├─ Phase 3: Log analysis (skipped if metrics-only)
  ├─ Phase 4: Correlation (adapted for metrics-only)
  └─ Phase 5: RCA synthesis
```

## File Impact

### New Files (self-contained, deletable to revert)
| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `src/agent/env-context.ts` | ~60 | EnvironmentContext cache |
| `src/agent/loki-resolver.ts` | ~80 | Loki label cascade resolver |
| `src/agent/service-classifier.ts` | ~30 | Service classification |

### Modified Files (minimal, reversible)
| File | Change |
|------|--------|
| `src/agent/investigation.ts` | Import modules, call Phase 0, pass context to prompts (~30 lines) |
| `src/agent/rca-prompts.ts` | Add optional `context` param to phase prompt functions |

### Untouched
`core.ts`, `intent.ts`, `discovery.ts`, `slack.ts`, `App.tsx`, `openai.ts`, config, CLI, MCP client.

## Modularity & Revert Strategy

All new modules are additive-only:
- New modules have no side effects and don't import each other.
- `investigation.ts` changes are behind conditionals: if context exists, use it; otherwise fall back to current behavior.
- `rca-prompts.ts` uses optional parameters with defaults.
- **To revert**: delete 3 new files, revert `investigation.ts` and `rca-prompts.ts`.

## Open Items

- Promtail parsing rules: user will share to validate LokiResolver cascade logic.
- Stem-stripping heuristic may need tuning per environment.

# Discover Agent — Design Spec

Rewrite the discover agent using Mastra with full CLI and GUI support, MCP-provider-agnostic service discovery, LLM-driven validation, interactive review, and version history.

## Context

The old discover agent (removed in PR #17 Mastra refactor) queried Prometheus for Consul metrics and enriched log labels from Loki. It was a standalone CLI command that wrote `services.yaml` non-interactively.

This rewrite:
- Ports discovery to a Mastra Agent + Workflow
- Makes it MCP-provider-agnostic (no hardcoded Prometheus/Loki/Consul tool names)
- Adds a validation phase (LLM verifies discovered services against actual data)
- Makes CLI interactive (review/edit before accepting)
- Adds GUI support (Dashboard sub-section with wizard, YAML editor, version history)
- Adds full version history with rollback

## Architecture

### Approach: Mastra Agent + Workflow

The discover agent is a Mastra Agent, and the full discover-review-write lifecycle is a two-phase workflow.

```
Phase 1: discover(config) → { services: ValidatedServiceConfig[] }
  ├── discoverStep: runs discover agent → raw ServiceConfig[]
  └── validateStep: runs validation agent → ValidatedServiceConfig[]

Phase 2: accept(services) → void
  ├── persistStep: writes services.yaml
  └── historyStep: saves version snapshot
```

Phase 1 and Phase 2 are separate function calls (not a single workflow with a pause). This enables the human-in-the-loop review between phases.

## Components

### 1. Discovery Agent (`src/agents/discover.ts`)

A Mastra Agent that receives all MCP tools from all configured providers. Its system prompt instructs it to:

1. Explore available tools to understand what monitoring systems are connected
2. Find a service registry/catalog (Consul metric, Kubernetes API, or whatever the tools expose)
3. For each discovered service, find:
   - A health/existence metric query
   - Log label mappings (which labels in the log system correspond to this service)
4. Return structured JSON matching the `ServiceConfig[]` schema

Design decisions:
- No hardcoded tool names — prompt says "use available tools to discover services"
- Uses `agent.generate()` (same as existing agents) with a fallback extractor agent to parse structured output from the response — follows the established pattern in evidence steps
- Max steps: 40 (configurable via `discovery.maxIterations` in config)
- Quirk handling: reuses existing `createQuirkPrepareStep()` for wind-down/midpoint nudge

### 2. Validation Agent (`src/agents/discover-validator.ts`)

A Mastra Agent that receives the discovered services list and MCP tools. Its job is to spot-check each service:

1. For each service, attempt to execute the metric query — does it return data?
2. For each service with log labels, query logs using those labels — do results come back?
3. Classify each service with a confidence level:
   - `verified` — both metrics and logs returned data
   - `partial` — one of metrics/logs worked, the other didn't
   - `unverified` — neither returned data (possible hallucination)
4. Return the original service list annotated with `confidence` and `validationNotes` per service

Design decisions:
- Deterministic tool calls, not free-form exploration — the agent gets explicit instructions per service
- Lightweight — max steps: 15, far fewer iterations than discovery
- Doesn't remove services — just annotates; the user decides during review
- Confidence levels surface in both CLI and GUI

### 3. Discovery Workflow (`src/workflows/discovery.ts`)

A plain TypeScript module (not a Mastra `createWorkflow()`) that orchestrates the two agents sequentially. Phase 1 calls the discover agent then the validation agent. Phase 2 persists results. This is simpler than a Mastra workflow since there's no parallel step execution needed and the human-in-the-loop pause doesn't map to Mastra's workflow primitives.

The step files (`src/workflows/steps/discover.ts` and `src/workflows/steps/validate.ts`) are plain async functions, not Mastra `createStep()` steps.

Streaming callbacks follow the same closure-based pattern as the investigation workflow (passed via a config object, not Mastra's event system):
- `onPhase('discovery' | 'validation')`
- `onIteration(phase, current, max, label)`
- `onToolCall(name, args, result?, duration?, error?, phase?)`

Adapter: `MastraDiscoverAdapter` in `src/server/agents.ts` wraps the workflow, exposes `discover()` and `accept()` methods, implements `IDiscoverAgent` interface. Used by both CLI and server.

### 4. Types (`src/types/discovery-types.ts`)

```typescript
interface ValidatedServiceConfig extends ServiceConfig {
  confidence: 'verified' | 'partial' | 'unverified';
  validationNotes: string;
}

interface ServiceRegistryVersion {
  id: string;           // ULID
  timestamp: string;    // ISO 8601
  services: ServiceConfig[];
  source: 'discovery' | 'manual';
}

interface IDiscoverAgent {
  discover(
    config: DiscoveryConfig,
    onPhase?: (phase: string) => void,
    onIteration?: (phase: string, current: number, max: number, label: string) => void,
    onToolCall?: (name: string, args: Record<string, unknown>, result?: string, durationMs?: number, error?: string, phase?: string) => void,
  ): Promise<ValidatedServiceConfig[]>;

  accept(services: ServiceConfig[], source: 'discovery' | 'manual'): Promise<string>;  // returns version id
}
```

Add `IDiscoverAgent` to `src/types/agent-interfaces.ts` alongside `IChatAgent` and `IInvestigationAgent`.

### 5. Version History (`src/services/registry.ts`)

File-based version store for `services.yaml` snapshots.

Storage layout (resolves relative to `services.yaml` via `getServicesFilePath()` in `src/config/loader.ts`, which follows symlinks — so `config.yaml` → `dev/config.yaml` → history lives in `dev/`):
```
dev/                              # gitignored — history is local like services.yaml
  services.yaml                   # current active registry
  services-history/
    01JQ7K...-discovery.yaml      # version file
    01JQ8M...-manual.yaml         # version file
    index.yaml                    # ordered list of versions with metadata
```

`index.yaml` format:
```yaml
- id: "01JQ7K..."
  timestamp: "2026-03-14T10:30:00Z"
  source: discovery
  serviceCount: 391
- id: "01JQ8M..."
  timestamp: "2026-03-14T11:00:00Z"
  source: manual
  serviceCount: 395
```

Each version file is a plain `ServiceConfig[]` YAML array — identical format to `services.yaml`.

API:
```typescript
interface ServiceRegistryStore {
  load(): ServiceConfig[];
  save(services: ServiceConfig[], source: 'discovery' | 'manual'): string;
  listVersions(): ServiceRegistryVersion[];
  getVersion(id: string): ServiceConfig[];
  rollback(id: string): void;
}
```

`ServiceRegistryStore` wraps and replaces the existing `loadServicesFile()` in `src/config/loader.ts` — it becomes the single code path for reading/writing `services.yaml`. `loadConfig()` calls `registryStore.load()` instead of `loadServicesFile()` directly.

Design decisions:
- File-based, not SQLite — keeps services.yaml and its history together, easy to inspect
- Rollback creates a new entry — rolling back to version X doesn't delete later versions, full audit trail
- No automatic pruning — versions accumulate
- History directory is gitignored (lives in `dev/` alongside secrets)

## Config Changes

The existing `DiscoverySchema` in `src/config/schema.ts` has a `consulMetric` field which is Consul-specific. Since the new design is MCP-provider-agnostic:
- Remove `consulMetric` from the schema
- Keep `autoRefresh`, `excludeServices`, and `maxIterations`
- The LLM discovers the catalog metric on its own via tool exploration

## CLI Interface

Interactive Ink React app at `src/cli/discover.tsx`, invoked via `npm run discover`.

States:
1. **Running** — streams phase progress (Discovery → Validation), tool calls, iteration counts
2. **Review** — shows summary table with confidence-colored rows (verified/partial/unverified counts), service list
3. **Editing** — pauses Ink renderer, spawns `$EDITOR` via `child_process.spawnSync` (blocking, takes over terminal), re-reads temp YAML file on close, resumes Ink renderer and returns to Review state
4. **Done** — writes `services.yaml`, saves version, exits

Review actions:
- `[a]` Accept all — write services.yaml, create version snapshot, exit
- `[e]` Edit in $EDITOR — open YAML in user's editor, re-validate on close, return to review
- `[r]` Reject — discard results, exit without writing
- `[f]` Filter unverified — remove unverified services, return to review

## GUI Interface

Services management lives as a sub-section within the Dashboard, not a separate top-level tab.

### First Run (Empty Registry)

Non-blocking banner on Dashboard: "No services configured. Run service discovery to detect your monitored services, or add them manually." with "Run Discovery" and "Dismiss" buttons. User can dismiss and use the app without services.

### Dashboard Services Card (Registry Populated)

Compact card at the bottom of Dashboard showing:
- Service count and last discovery timestamp
- Confidence breakdown (verified/partial/unverified)
- "Manage" button → opens services management view
- "Re-discover" button → kicks off discovery

### Services Management View

Replaces Dashboard content (breadcrumb: `Dashboard › Services`). Contains:
- Toolbar: "Run Discovery" and "Version History" buttons
- YAML editor using CodeMirror 6 (`@codemirror/lang-yaml` for syntax highlighting, `@codemirror/view` for line numbers) — lightweight, tree-shakeable, already used in similar projects. Wrapped in a `YamlEditor` component with Save/Discard buttons.
- Service count indicator

### Discovery Progress View

Shown when discovery is running (breadcrumb: `Dashboard › Services › Discovery`):
- Phase stepper: Discovery → Validation → Review (with checkmark/spinner/pending states)
- Progress bar with iteration counter
- Streaming tool call log with timestamps

### Review Results View

Shown after discovery completes (breadcrumb: `Dashboard › Services › Review`):
- Summary card: total services found, verified/partial/unverified counts
- Scrollable service name list, color-coded by confidence
- Expandable YAML editor (collapsed by default) — user can edit before accepting
- Action buttons: Accept, Reject, Filter Unverified

### Version History View

Accessed from "Version History" button in management toolbar (breadcrumb: `Dashboard › Services › History`):
- List of versions with timestamps, source tags (discovery/manual), service counts
- Current version highlighted
- View button (read-only YAML) and Restore button per version

## Server API

### REST Endpoints (added to `src/server/routes.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/services` | Get current service registry (exists) |
| `PUT` | `/api/services` | Save edited services.yaml (manual edit) |
| `GET` | `/api/services/versions` | List version history |
| `GET` | `/api/services/versions/:id` | Get a specific version's YAML |
| `POST` | `/api/services/versions/:id/restore` | Rollback to a version |
| `GET` | `/api/services/pending` | Get pending discovery results |

### WebSocket Messages (added to `src/types/ws-types.ts`)

Client → Server:
```
{ type: "discover" }                                              // kick off discovery
{ type: "discover:accept", services: ServiceConfig[] }            // accept with optional edits (parsed objects, not YAML string)
{ type: "discover:reject" }                                       // reject results
```

Server → Client:
```
{ type: "discover:phase", phase, status }
{ type: "discover:iteration", phase, current, max }
{ type: "discover:tool_call", tool, args, status }
{ type: "discover:complete", services: ValidatedServiceConfig[] }
{ type: "discover:error", message }
{ type: "discover:pending", services: ValidatedServiceConfig[] }
{ type: "discover:resolved" }                                     // another client already accepted/rejected
```

Discovery streams over WebSocket (long-running). CRUD operations use REST (short-lived).

## Auto-Refresh Behavior

When `discovery.autoRefresh: true`:

1. Server starts → spawns discovery workflow in background (non-blocking)
2. Discovery completes → results stored in memory as "pending discovery"
3. GUI client connects → server sends `discover:pending` message
4. User accepts/rejects through normal review UI
5. If no GUI client connects, pending results sit in memory until one does

Edge cases:
- Existing `services.yaml` + autoRefresh: review UI shows context ("391 → 405, 14 new")
- Multiple GUI clients: first to accept/reject wins, others get `discover:resolved`
- Server restart: pending results are lost (in-memory only). This is acceptable — auto-refresh will re-run on next startup.

## File Inventory

### New Files

| File | Purpose |
|------|---------|
| `src/agents/discover.ts` | Discovery Mastra Agent |
| `src/agents/discover-validator.ts` | Validation Mastra Agent |
| `src/workflows/discovery.ts` | Discovery workflow |
| `src/workflows/steps/discover.ts` | Discovery step |
| `src/workflows/steps/validate.ts` | Validation step |
| `src/types/discovery-types.ts` | Types |
| `src/services/registry.ts` | ServiceRegistryStore |
| `src/cli/discover.tsx` | CLI discover entrypoint |
| `src/web/components/ServicesSection.tsx` | Dashboard services card |
| `src/web/components/ServicesManage.tsx` | Services management view |
| `src/web/components/DiscoveryProgress.tsx` | Discovery progress view |
| `src/web/components/DiscoveryReview.tsx` | Review results view |
| `src/web/components/VersionHistory.tsx` | Version history list |
| `src/web/components/FirstRunBanner.tsx` | Empty registry banner |

### Modified Files

| File | Change |
|------|--------|
| `src/server/routes.ts` | Services CRUD + version history REST endpoints |
| `src/server/ws-handler.ts` | Discover WebSocket message handling |
| `src/server/agents.ts` | `MastraDiscoverAdapter` |
| `src/server/index.ts` | Auto-refresh startup trigger, pending state |
| `src/types/ws-types.ts` | Discover message types |
| `src/config/schema.ts` | Ensure `DiscoveryConfig` schema present |
| `src/web/App.tsx` | Route to services sub-views within Dashboard |
| `src/web/components/Dashboard.tsx` | Add ServicesSection + FirstRunBanner |
| `package.json` | Add `"discover"` script |

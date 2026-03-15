# Refactor: Break Up investigation.ts + Consolidate Directory Structure

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the 1,140-line `investigation.ts` into focused modules, consolidate single-file directories, and rename misleading files.

**Architecture:** Extract tool utilities, Zod schemas, and step factories from investigation.ts into separate files under `workflows/steps/`. Introduce a shared `buildEvidenceStep()` abstraction to deduplicate the 3 near-identical evidence step factories. Move `history/store.ts` into `workflows/` (its only consumer). Move `shared/ws-types.ts` into `types/`. Rename `server/mastra-adapter.ts` to `server/agents.ts`.

**Tech Stack:** TypeScript ESM, Mastra workflows, Vitest

**Prerequisite:** All 301 tests must pass before starting. Run `npx vitest run` to confirm.

---

## Chunk 1: Extract Utilities and Schemas from investigation.ts

### Task 1: Extract tool utilities to `workflows/tool-utils.ts`

**Files:**
- Create: `src/workflows/tool-utils.ts`
- Modify: `src/workflows/investigation.ts`

- [ ] **Step 1: Create `src/workflows/tool-utils.ts`**

Move these functions from `investigation.ts` (lines 58–162):
- `resolveGrafanaTime` (58–66)
- `coerceToolArgs` (68–87)
- `stripToolPrefix` (93–96)
- `unwrapMcpResult` (103–112)
- `wrapToolsWithCallbacks` (114–142)
- `selectToolsBySuffix` (154–162)
- Tool allowlist constants: `ANOMALY_TOOLS`, `METRICS_TOOLS`, `LOGS_TOOLS`, `INFRA_TOOLS` (149–152)
- `buildTimeWindowHint` (168–182)
- `buildServiceContextHint` (188–205)
- The `debug` helper (line 320)

Export: `wrapToolsWithCallbacks`, `selectToolsBySuffix`, `buildTimeWindowHint`, `buildServiceContextHint`, `debug`, and the 4 tool allowlist constants. Keep `resolveGrafanaTime`, `coerceToolArgs`, `stripToolPrefix`, `unwrapMcpResult` as internal (called by the exported functions).

Import `WorkflowConfig` type from investigation.ts (it stays there as the shared config interface).

- [ ] **Step 2: Update `investigation.ts` imports**

Replace the moved code with:
```typescript
import {
  wrapToolsWithCallbacks, selectToolsBySuffix,
  buildTimeWindowHint, buildServiceContextHint, debug,
  ANOMALY_TOOLS, METRICS_TOOLS, LOGS_TOOLS, INFRA_TOOLS,
} from "./tool-utils.js";
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/workflows/`
Expected: PASS (no behavior change)

- [ ] **Step 4: Commit**

```bash
git add src/workflows/tool-utils.ts src/workflows/investigation.ts
git commit -m "refactor: extract tool utilities from investigation.ts to tool-utils.ts"
```

---

### Task 2: Extract Zod schemas to `workflows/schemas.ts`

**Files:**
- Create: `src/workflows/schemas.ts`
- Modify: `src/workflows/investigation.ts`

- [ ] **Step 1: Create `src/workflows/schemas.ts`**

Move all Zod schema definitions from `investigation.ts` (lines 207–317):
- `WorkflowInputSchema`
- `PrefetchOutputSchema`
- `AnomalyOutputSchema`
- `PlanningOutputSchema`
- `EvidenceOutputSchema`
- `ParallelEvidenceSchema`
- `SynthesisOutputSchema`
- `PostSynthesisOutputSchema`

Import `PrefetchedContextSchema` from `../types/workflow-state.js` (already defined there — investigation.ts currently duplicates it). Use the existing one instead of the local copy.

Export all schemas.

- [ ] **Step 2: Update `investigation.ts` imports**

Replace the schema block with:
```typescript
import {
  WorkflowInputSchema, PrefetchOutputSchema, AnomalyOutputSchema,
  PlanningOutputSchema, EvidenceOutputSchema, SynthesisOutputSchema,
  PostSynthesisOutputSchema,
} from "./schemas.js";
```

Remove the local `PrefetchedContextSchema` duplicate (use the one from schemas.ts which imports from types/).

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/workflows/schemas.ts src/workflows/investigation.ts
git commit -m "refactor: extract Zod schemas from investigation.ts to schemas.ts"
```

---

## Chunk 2: Extract Step Factories with Evidence Abstraction

### Task 3: Create shared evidence step builder

**Files:**
- Create: `src/workflows/steps/evidence.ts`
- Create: `src/workflows/steps/evidence.test.ts`

- [ ] **Step 1: Create `src/workflows/steps/evidence.ts`**

Define the `EvidenceStepConfig` interface and `buildEvidenceStep` factory:

```typescript
import { createStep } from "@mastra/core/workflows";
import type { LanguageModel } from "ai";
import type { Agent } from "@mastra/core/agent";
import type { WorkflowConfig } from "../investigation.js";
import { getToolsByRole } from "../../mcp/provider.js";
import {
  selectToolsBySuffix, wrapToolsWithCallbacks,
  buildTimeWindowHint, buildServiceContextHint, debug,
} from "../tool-utils.js";
import { PlanningOutputSchema, EvidenceOutputSchema } from "../schemas.js";
import { safeJsonParse } from "../../agents/shared/processors.js";

export interface EvidenceStepConfig {
  id: string;                          // e.g. "metrics-evidence"
  phaseName: string;                   // e.g. "metrics"
  iterationStart: number;              // e.g. 2 for metrics, 3 for logs, 4 for infra
  toolRole: string;                    // MCP provider role: "metrics" or "logs"
  toolAllowlist: string[];             // e.g. METRICS_TOOLS
  createAgent: (opts: { model: LanguageModel; tools: Record<string, any>; useQuirkHandling?: boolean }) => Agent;
  buildPrompt: (inputData: any, config: WorkflowConfig) => string;
  extractorSchema: string;             // JSON schema hint for fallback extractor
  fallbackMessage: string;             // e.g. "Metrics analysis unavailable"
}

export function buildEvidenceStep(workflowConfig: WorkflowConfig, stepConfig: EvidenceStepConfig) {
  return createStep({
    id: stepConfig.id,
    description: `Evidence gathering: ${stepConfig.phaseName}`,
    inputSchema: PlanningOutputSchema,
    outputSchema: EvidenceOutputSchema,
    execute: async ({ inputData }) => {
      debug(`${stepConfig.phaseName.toUpperCase()} step entered`);
      workflowConfig.onPhase?.("Analyzing metrics, logs & infrastructure");
      workflowConfig.onIteration?.(stepConfig.phaseName, stepConfig.iterationStart, 6, `Analyzing ${stepConfig.phaseName}`);

      // 1. Get and filter tools
      const rawTools = await getToolsByRole(workflowConfig.providers, stepConfig.toolRole as any).catch(() => ({}));
      const filtered = selectToolsBySuffix(rawTools, stepConfig.toolAllowlist);
      const tools = wrapToolsWithCallbacks(filtered, workflowConfig.onToolCall, stepConfig.phaseName);

      // 2. Create agent
      const agent = stepConfig.createAgent({
        model: workflowConfig.model,
        tools,
        useQuirkHandling: workflowConfig.useQuirkHandling,
      });

      // 3. Build prompt
      const prompt = stepConfig.buildPrompt(inputData, workflowConfig);

      // 4. Run agent with step tracking
      let agentResult: { text: string } = { text: "" };
      const toolData: string[] = [];
      let iterationCount = 0;
      try {
        agentResult = await agent.generate(prompt, {
          onStepFinish: (step: any) => {
            try {
              iterationCount++;
              workflowConfig.onIteration?.(stepConfig.phaseName, iterationCount, 10, `Step ${iterationCount}`);
              if (step.toolResults?.length) {
                for (const tr of step.toolResults) {
                  const payload = tr.payload ?? tr;
                  const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
                  const nestedContent = payload.result?.content?.[0]?.text;
                  const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
                  const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                  const truncated = resultStr.length > 2000 ? resultStr.slice(0, 2000) + "..." : resultStr;
                  toolData.push(`Tool: ${toolName}\nResult: ${truncated}`);
                }
              }
              if (step.text) toolData.push(`Model: ${step.text}`);
            } catch (err) {
              debug(`${stepConfig.phaseName.toUpperCase()} onStepFinish error:`, err);
            }
          },
        });
      } catch (err) {
        debug(`${stepConfig.phaseName.toUpperCase()} agent.generate error:`, err);
      }

      // 5. Extract JSON (with fallback extractor)
      let text = agentResult.text;
      if (!text?.trim() && toolData.length > 0) {
        debug(`${stepConfig.phaseName.toUpperCase()}: empty text, extracting from ${toolData.length} captured tool results`);
        const { Agent: ExtractAgent } = await import("@mastra/core/agent");
        const extractor = new ExtractAgent({
          name: `${stepConfig.phaseName}-extractor`,
          id: `${stepConfig.phaseName}-extractor`,
          instructions: `Extract structured data from investigation results. Return ONLY valid JSON: ${stepConfig.extractorSchema}`,
          model: workflowConfig.model as any,
        });
        try {
          const extraction = await extractor.generate(toolData.join("\n\n"));
          text = extraction.text ?? "";
        } catch { /* keep empty */ }
      }

      // 6. Parse and return
      const parsed = safeJsonParse(text);
      if (parsed) {
        return {
          summary: parsed.summary ?? stepConfig.fallbackMessage,
          observations: parsed.observations ?? [],
          ...(parsed.anomalyWindow ? { anomalyWindow: parsed.anomalyWindow } : {}),
        };
      }
      return { summary: stepConfig.fallbackMessage, observations: [] };
    },
  });
}
```

Then define the 3 evidence step configs and their exported builders:

```typescript
export function buildMetricsStep(config: WorkflowConfig) {
  return buildEvidenceStep(config, {
    id: "metrics-evidence",
    phaseName: "metrics",
    iterationStart: 2,
    toolRole: "metrics",
    toolAllowlist: METRICS_TOOLS,
    createAgent: createMetricsAgent,
    buildPrompt: (inputData, wfConfig) => {
      const { anomalyContext } = inputData;
      const timeWindowHint = buildTimeWindowHint(anomalyContext.summary, anomalyContext.userMessage);
      const { metricsHint } = buildServiceContextHint(wfConfig.services, anomalyContext.serviceName);
      return [
        anomalyContext.prefetchContext.datasourceHints,
        timeWindowHint,
        anomalyContext.prefetchContext.panelQueryHints,
        metricsHint,
        `Known issue: ${anomalyContext.userMessage}`,
        anomalyContext.serviceName ? `Service: ${anomalyContext.serviceName}` : "",
        inputData.metricFocus?.length ? `Focus areas: ${inputData.metricFocus.join(", ")}` : "",
      ].filter(Boolean).join("\n");
    },
    extractorSchema: '{"summary": "string", "observations": [{"metric": "string", "currentValue": "string", "baselineValue": "string", "severity": "string"}]}',
    fallbackMessage: "Metrics analysis unavailable",
  });
}

export function buildLogsStep(config: WorkflowConfig) {
  return buildEvidenceStep(config, {
    id: "logs-evidence",
    phaseName: "logs",
    iterationStart: 3,
    toolRole: "logs",
    toolAllowlist: LOGS_TOOLS,
    createAgent: createLogsAgent,
    buildPrompt: (inputData, wfConfig) => {
      const { anomalyContext } = inputData;
      const { prefetchContext } = anomalyContext;
      const timeWindowHint = buildTimeWindowHint(anomalyContext.summary, anomalyContext.userMessage);
      const { logLabelsHint } = buildServiceContextHint(wfConfig.services, anomalyContext.serviceName);
      const selectorHint = prefetchContext.workingLogSelectors.length > 0
        ? `VALIDATED LOG SELECTOR (pre-tested, returns real logs — use this as your primary selector):\n  ${prefetchContext.workingLogSelectors[0]}\nThe configured logLabels may NOT return results. Use the validated selector above as your FIRST query.`
        : "";
      return [
        prefetchContext.datasourceHints,
        timeWindowHint,
        prefetchContext.logLabelHints,
        logLabelsHint,
        selectorHint,
        `Known issue: ${anomalyContext.userMessage}`,
        anomalyContext.serviceName ? `Service: ${anomalyContext.serviceName}` : "",
        inputData.logFocus?.length ? `Focus areas: ${inputData.logFocus.join(", ")}` : "",
      ].filter(Boolean).join("\n");
    },
    extractorSchema: '{"summary": "string", "observations": [{"pattern": "string", "count": "string", "firstSeen": "string", "lastSeen": "string", "sample": "string", "sampleLines": ["string"]}]}',
    fallbackMessage: "Log analysis unavailable",
  });
}

export function buildInfraStep(config: WorkflowConfig) {
  return buildEvidenceStep(config, {
    id: "infra-evidence",
    phaseName: "infra",
    iterationStart: 4,
    toolRole: "metrics",
    toolAllowlist: INFRA_TOOLS,
    createAgent: createInfraAgent,
    buildPrompt: (inputData, _wfConfig) => {
      const { anomalyContext } = inputData;
      const timeWindowHint = buildTimeWindowHint(anomalyContext.summary, anomalyContext.userMessage);
      return [
        anomalyContext.prefetchContext.datasourceHints,
        timeWindowHint,
        anomalyContext.prefetchContext.panelQueryHints,
        `Known issue: ${anomalyContext.userMessage}`,
        anomalyContext.serviceName ? `Service: ${anomalyContext.serviceName}` : "",
        inputData.infraFocus?.length ? `Focus areas: ${inputData.infraFocus.join(", ")}` : "",
      ].filter(Boolean).join("\n");
    },
    extractorSchema: '{"summary": "string", "observations": [{"resource": "string", "status": "string", "detail": "string"}]}',
    fallbackMessage: "Infrastructure analysis unavailable",
  });
}
```

Import the agent factories and tool constants at the top.

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS (new file, not yet wired in)

- [ ] **Step 3: Commit**

```bash
git add src/workflows/steps/evidence.ts
git commit -m "feat: add shared evidence step builder with metrics/logs/infra configs"
```

---

### Task 4: Extract anomaly and planning steps

**Files:**
- Create: `src/workflows/steps/anomaly.ts`
- Create: `src/workflows/steps/planning.ts`

- [ ] **Step 1: Create `src/workflows/steps/anomaly.ts`**

Move `buildAnomalyStep` (lines 360–477) from investigation.ts. Import dependencies from `../tool-utils.js`, `../schemas.js`, and agent factories.

- [ ] **Step 2: Create `src/workflows/steps/planning.ts`**

Move `buildPlanningStep` (lines 482–569) from investigation.ts. This step imports from `../../history/store.js` (to be moved in Task 7 — use the current path for now, update in Task 7).

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/workflows/steps/anomaly.ts src/workflows/steps/planning.ts
git commit -m "refactor: extract anomaly and planning steps from investigation.ts"
```

---

### Task 5: Extract synthesis and post-synthesis steps

**Files:**
- Create: `src/workflows/steps/synthesis.ts`
- Create: `src/workflows/steps/post-synthesis.ts`

- [ ] **Step 1: Create `src/workflows/steps/synthesis.ts`**

Move `buildSynthesisStep` (lines 891–1035) from investigation.ts. This step uses `buildTimeline` and `validateSeverity` from `../helpers.js`.

- [ ] **Step 2: Create `src/workflows/steps/post-synthesis.ts`**

Move `buildPostSynthesisStep` (lines 1040–1088). Uses `saveIncident` from `../../history/store.js`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/workflows/steps/synthesis.ts src/workflows/steps/post-synthesis.ts
git commit -m "refactor: extract synthesis and post-synthesis steps from investigation.ts"
```

---

### Task 6: Slim investigation.ts to orchestration only

**Files:**
- Modify: `src/workflows/investigation.ts`

- [ ] **Step 1: Rewrite investigation.ts**

Replace the entire file with orchestration-only code (~80 lines):

```typescript
import { createWorkflow } from "@mastra/core/workflows";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../mcp/provider.js";
import type { ServiceConfig } from "../config/schema.js";
import type { OnToolCallEnriched, OnIteration } from "../types/agent-interfaces.js";
import { WorkflowInputSchema, PostSynthesisOutputSchema } from "./schemas.js";
import { buildPrefetchStep } from "./steps/prefetch.js";  // rename in Task 8
import { buildAnomalyStep } from "./steps/anomaly.js";
import { buildPlanningStep } from "./steps/planning.js";
import { buildMetricsStep, buildLogsStep, buildInfraStep } from "./steps/evidence.js";
import { buildSynthesisStep } from "./steps/synthesis.js";
import { buildPostSynthesisStep } from "./steps/post-synthesis.js";

export interface WorkflowConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  services: ServiceConfig[];
  useQuirkHandling?: boolean;
  projectRoot?: string;
  onPhase?: (phase: string) => void;
  onIteration?: (phase: string, iteration: number, maxIterations: number, label: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, result?: string, duration?: number, error?: string, phase?: string) => void;
}

export function createInvestigationWorkflow(workflowConfig: WorkflowConfig) {
  const prefetchStep = buildPrefetchStep(workflowConfig);
  const anomalyStep = buildAnomalyStep(workflowConfig);
  const planningStep = buildPlanningStep(workflowConfig);
  const metricsStep = buildMetricsStep(workflowConfig);
  const logsStep = buildLogsStep(workflowConfig);
  const infraStep = buildInfraStep(workflowConfig);
  const synthesisStep = buildSynthesisStep(workflowConfig);
  const postSynthesisStep = buildPostSynthesisStep(workflowConfig);

  const workflow = createWorkflow({
    id: "investigation",
    description: "Multi-phase root cause analysis investigation pipeline",
    inputSchema: WorkflowInputSchema,
    outputSchema: PostSynthesisOutputSchema,
    steps: [prefetchStep, anomalyStep, planningStep, metricsStep, logsStep, infraStep, synthesisStep, postSynthesisStep],
  });

  workflow
    .then(prefetchStep)
    .then(anomalyStep)
    .then(planningStep)
    .parallel([metricsStep, logsStep, infraStep])
    .then(synthesisStep)
    .then(postSynthesisStep)
    .commit();

  return workflow;
}
```

Re-export `buildMetricsStep`, `buildLogsStep`, `buildInfraStep`, `buildSynthesisStep` for test compatibility if tests import them from `investigation.js`.

- [ ] **Step 2: Update existing test imports if needed**

Check `src/workflows/investigation.test.ts` — if it imports step builders from `./investigation.js`, update to import from `./steps/evidence.js` etc.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: Only pre-existing mastra-adapter error

- [ ] **Step 5: Commit**

```bash
git add src/workflows/investigation.ts src/workflows/investigation.test.ts
git commit -m "refactor: slim investigation.ts to orchestration-only (~80 lines, was 1140)"
```

---

## Chunk 3: Consolidate Directory Structure

### Task 7: Move `history/store.ts` → `workflows/history.ts`

**Files:**
- Move: `src/history/store.ts` → `src/workflows/history.ts`
- Modify: `src/workflows/steps/planning.ts` (update import)
- Modify: `src/workflows/steps/post-synthesis.ts` (update import)
- Delete: `src/history/` directory

- [ ] **Step 1: Move file**

```bash
git mv src/history/store.ts src/workflows/history.ts
```

- [ ] **Step 2: Update imports in planning.ts and post-synthesis.ts**

Change `from "../../history/store.js"` → `from "../history.js"`

- [ ] **Step 3: Run tests, commit**

Run: `npx vitest run`

```bash
git add src/workflows/steps/planning.ts src/workflows/steps/post-synthesis.ts
git commit -m "refactor: move history/store.ts into workflows/ (its only consumer)"
```

---

### Task 8: Move `shared/ws-types.ts` → `types/ws-types.ts`

**Files:**
- Move: `src/shared/ws-types.ts` → `src/types/ws-types.ts`
- Update imports in: `src/server/ws-handler.ts`, `src/web/hooks/useWebSocket.ts`, and any other consumers
- Delete: `src/shared/` directory

- [ ] **Step 1: Move file and update imports**

```bash
git mv src/shared/ws-types.ts src/types/ws-types.ts
```

Search for `from.*shared/ws-types` and update all import paths.

- [ ] **Step 2: Run tests, commit**

Run: `npx vitest run`

```bash
git commit -m "refactor: move ws-types.ts from shared/ to types/"
```

---

### Task 9: Rename `server/mastra-adapter.ts` → `server/agents.ts`

**Files:**
- Rename: `src/server/mastra-adapter.ts` → `src/server/agents.ts`
- Rename: `src/server/mastra-adapter.test.ts` → `src/server/agents.test.ts`
- Update imports in: `src/server/index.ts`, `src/cli.tsx`

- [ ] **Step 1: Rename files**

```bash
git mv src/server/mastra-adapter.ts src/server/agents.ts
git mv src/server/mastra-adapter.test.ts src/server/agents.test.ts
```

- [ ] **Step 2: Update imports**

In `src/server/index.ts`: change `from "./mastra-adapter.js"` → `from "./agents.js"`
In `src/cli.tsx`: change `import("./server/mastra-adapter.js")` → `import("./server/agents.js")`
In `src/server/agents.test.ts`: change `from "./mastra-adapter.js"` → `from "./agents.js"`

- [ ] **Step 3: Run tests, commit**

Run: `npx vitest run`

```bash
git commit -m "refactor: rename mastra-adapter.ts to agents.ts (no longer an adapter)"
```

---

### Task 10: Move prefetch.ts into steps/

**Files:**
- Move: `src/workflows/prefetch.ts` → `src/workflows/steps/prefetch.ts`
- Move: `src/workflows/prefetch.test.ts` → `src/workflows/steps/prefetch.test.ts`
- Update import in: `src/workflows/investigation.ts`

- [ ] **Step 1: Move files**

```bash
git mv src/workflows/prefetch.ts src/workflows/steps/prefetch.ts
git mv src/workflows/prefetch.test.ts src/workflows/steps/prefetch.test.ts
```

- [ ] **Step 2: Update imports**

In `investigation.ts`: change `from "./prefetch.js"` → `from "./steps/prefetch.js"`
In `prefetch.test.ts`: update any relative imports that changed.

- [ ] **Step 3: Run tests, commit**

Run: `npx vitest run`

```bash
git commit -m "refactor: move prefetch.ts into workflows/steps/"
```

---

### Task 11: Final verification and CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All 301 tests PASS

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: Only pre-existing mastra-adapter error (now in agents.ts)

- [ ] **Step 3: Verify final structure**

Expected directory tree:
```
src/
├── agents/
│   ├── intent.ts
│   ├── chat.ts
│   ├── anomaly-detector.ts
│   ├── planner.ts
│   ├── metrics.ts
│   ├── logs.ts
│   ├── infra.ts
│   ├── synthesis.ts
│   └── shared/
│       ├── time-context.ts
│       ├── processors.ts
│       └── prepare-step.ts
├── workflows/
│   ├── investigation.ts     ← ~80 lines (orchestration only)
│   ├── schemas.ts           ← Zod step schemas
│   ├── tool-utils.ts        ← tool wrapping/selection/coercion
│   ├── helpers.ts           ← timeline, severity, time utils
│   ├── history.ts           ← incident history (moved from src/history/)
│   └── steps/
│       ├── prefetch.ts      ← datasource/dashboard/log discovery
│       ├── anomaly.ts       ← anomaly detection step
│       ├── planning.ts      ← hypothesis generation step
│       ├── evidence.ts      ← shared builder + metrics/logs/infra configs
│       ├── synthesis.ts     ← RCA synthesis step
│       └── post-synthesis.ts ← save to history step
├── server/
│   ├── index.ts
│   ├── agents.ts            ← renamed from mastra-adapter.ts
│   ├── ws-handler.ts
│   ├── routes.ts
│   └── db.ts
├── types/
│   ├── ws-types.ts          ← moved from src/shared/
│   ├── rca-types.ts
│   ├── agent-interfaces.ts
│   ├── agent-types.ts
│   ├── llm-types.ts
│   └── workflow-state.ts
├── config/
├── mcp/
├── mastra/
├── memory/
├── skills/
├── interfaces/cli/
└── web/
```

- [ ] **Step 4: Update CLAUDE.md Architecture section**

Reflect the new structure — investigation workflow is now in `workflows/` with step factories in `workflows/steps/`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for refactored workflow structure"
```

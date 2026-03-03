# RCA Evidence Enrichment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enrich RCA reports with raw log samples, Loki search terms, Grafana dashboard links, and panel images so the CLI output gives actionable evidence.

**Architecture:** Extend `LogFindings` and `RcaReport` types with new evidence fields, update prompts to instruct the LLM to collect concrete evidence, wire image capture through `runPhase`, and fix `formatRcaText` to render all evidence fields.

**Tech Stack:** TypeScript, Vitest, Ink (CLI), OpenAI Responses API, Grafana MCP

---

### Task 1: Extend `LogFindings` and `RcaReport` types

**Files:**
- Modify: `src/agent/rca-types.ts`

**Step 1: Write the failing tests**

In `src/notifications/rca-blocks.test.ts`, the fixture `report` will fail to compile once `RcaReport` has new required fields. Update the fixture now so it keeps passing after the type change. Add the two new fields with empty defaults:

```ts
const report: RcaReport = {
  service: "payments-api",
  severity: "high",
  summary: "High error rate detected",
  rootCause: "DB connection pool exhausted",
  evidence: {
    metrics: ["error_rate: 18% at 14:32 UTC"],
    logs: ["connection timeout after 30s (340x)"],
    infra: ["pod restarted 3x (OOMKilled)"],
  },
  dashboardLinks: [],
  panelImages: [],
  recommendedActions: ["Scale connection pool", "Restart pods"],
  confidence: "high",
  investigatedAt: "2026-02-25T14:37:00.000Z",
};
```

In `src/interfaces/cli/cli-utils.test.ts`, update `baseReport` the same way:

```ts
const baseReport: RcaReport = {
  ...existing fields...,
  dashboardLinks: [],
  panelImages: [],
};
```

**Step 2: Run tests to verify they fail (type errors)**

```bash
cd .worktrees/mvp && npx tsc --noEmit 2>&1 | head -30
```
Expected: Type errors about missing `dashboardLinks`, `panelImages` on `RcaReport`.

**Step 3: Extend the types**

In `src/agent/rca-types.ts`:

```ts
import type { ImageAttachment } from "./types.js";

export type MetricFindings = {
  observations: string[];
  baseline: string;
  anomalyWindow: string;
};

export type LogFindings = {
  errorPatterns: string[];
  stackTraces: string[];
  logSamples: string[];      // up to 5 raw log lines from Loki
  lokiSearchTerms: string[]; // ready-to-use Loki queries
  firstOccurrence: string;
};

export type InfraFindings = {
  podHealth: string[];
  nodeHealth: string[];
  recentEvents: string[];
};

export type RcaReport = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  rootCause: string;
  evidence: {
    metrics: string[];
    logs: string[];
    infra: string[];
  };
  dashboardLinks: string[];      // Grafana panel URLs
  panelImages: ImageAttachment[]; // panel screenshots
  recommendedActions: string[];
  confidence: "low" | "medium" | "high";
  investigatedAt: string;
};

export type InvestigationIntent =
  | { intent: "investigation"; service?: string }
  | { intent: "question" };
```

**Step 4: Run type check**

```bash
cd .worktrees/mvp && npx tsc --noEmit 2>&1 | head -30
```
Expected: Errors now shift to `investigation.ts` and `rca-blocks.ts` (not yet updated — that's fine, we'll fix them in later tasks).

**Step 5: Commit**

```bash
cd .worktrees/mvp && git add src/agent/rca-types.ts src/notifications/rca-blocks.test.ts src/interfaces/cli/cli-utils.test.ts
git commit -m "feat: extend LogFindings and RcaReport types with evidence fields"
```

---

### Task 2: Update JSON schemas and prompts

**Files:**
- Modify: `src/agent/rca-prompts.ts`
- Modify: `src/agent/rca-prompts.test.ts`

**Step 1: Write failing tests**

Add to `src/agent/rca-prompts.test.ts`:

```ts
it("LOG_FINDINGS_SCHEMA has logSamples and lokiSearchTerms fields", () => {
  const schema = LOG_FINDINGS_SCHEMA.json_schema.schema as { required: string[] };
  expect(schema.required).toContain("logSamples");
  expect(schema.required).toContain("lokiSearchTerms");
});

it("RCA_REPORT_SCHEMA has dashboardLinks field", () => {
  const schema = RCA_REPORT_SCHEMA.json_schema.schema as { required: string[] };
  expect(schema.required).toContain("dashboardLinks");
});

it("LOG_CORRELATION_PROMPT instructs LLM to collect raw log samples", () => {
  expect(LOG_CORRELATION_PROMPT).toContain("raw log");
});

it("METRIC_DEEP_DIVE_PROMPT instructs LLM to include dashboard URL", () => {
  expect(METRIC_DEEP_DIVE_PROMPT).toContain("dashboard");
  expect(METRIC_DEEP_DIVE_PROMPT).toContain("URL");
});
```

**Step 2: Run tests to verify they fail**

```bash
cd .worktrees/mvp && npx vitest run src/agent/rca-prompts.test.ts 2>&1 | tail -20
```
Expected: 4 new tests FAIL.

**Step 3: Update schemas and prompts**

Replace the relevant sections in `src/agent/rca-prompts.ts`:

**`LOG_CORRELATION_PROMPT`** — replace with:
```ts
export const LOG_CORRELATION_PROMPT = `You are investigating a service anomaly. Query the recent logs for the affected service using the available Loki query tools to find:
- Recurring error messages or exception patterns
- Stack traces or relevant error details
- When the errors first appeared

For each error pattern found, include up to 5 raw log lines verbatim (exact text as returned by the query tool).
Also generate 1-3 reusable Loki search terms (e.g. {job="myservice"} |= "exception") that a human could paste directly into Grafana Explore to reproduce your findings.

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;
```

**`METRIC_DEEP_DIVE_PROMPT`** — replace with:
```ts
export const METRIC_DEEP_DIVE_PROMPT = `You are investigating a service anomaly. Your job is to deeply analyse the metrics for the affected service.
Query the metrics to determine:
- What values are currently abnormal (include exact numbers and timestamps)
- What the baseline/normal range appears to be
- When the anomaly window started

After querying metrics, use the get_panel_image tool to capture screenshots of the most relevant Grafana panels showing the anomaly. When calling get_panel_image, note the dashboardUid and panelId you used, and include the full Grafana dashboard URL in the format: https://<grafana-host>/d/<dashboardUid>?panelId=<panelId> in your observations.

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;
```

**`RCA_SYNTHESIS_PROMPT`** — replace with:
```ts
export const RCA_SYNTHESIS_PROMPT = `You are performing root cause analysis. Based on the metric, log, and infrastructure findings provided, identify the root cause of the anomaly.
Determine the confidence level based on evidence quality:
- high: all 3 evidence types present and consistent
- medium: 2 of 3 evidence types, or suggestive but not conclusive
- low: only 1 evidence type, or contradictory findings

Extract any Grafana dashboard URLs found in the metric findings observations and include them in dashboardLinks.

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;
```

**`LOG_FINDINGS_SCHEMA`** — add new fields:
```ts
export const LOG_FINDINGS_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "log_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        errorPatterns: { type: "array", items: { type: "string" } },
        stackTraces: { type: "array", items: { type: "string" } },
        logSamples: { type: "array", items: { type: "string" } },
        lokiSearchTerms: { type: "array", items: { type: "string" } },
        firstOccurrence: { type: "string" },
      },
      required: ["errorPatterns", "stackTraces", "logSamples", "lokiSearchTerms", "firstOccurrence"],
      additionalProperties: false,
    },
  },
};
```

**`RCA_REPORT_SCHEMA`** — add `dashboardLinks`:
```ts
export const RCA_REPORT_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "rca_report",
    strict: true,
    schema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        summary: { type: "string" },
        rootCause: { type: "string" },
        evidence: {
          type: "object",
          properties: {
            metrics: { type: "array", items: { type: "string" } },
            logs: { type: "array", items: { type: "string" } },
            infra: { type: "array", items: { type: "string" } },
          },
          required: ["metrics", "logs", "infra"],
          additionalProperties: false,
        },
        dashboardLinks: { type: "array", items: { type: "string" } },
        recommendedActions: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["severity", "summary", "rootCause", "evidence", "dashboardLinks", "recommendedActions", "confidence"],
      additionalProperties: false,
    },
  },
};
```

**Step 4: Run tests**

```bash
cd .worktrees/mvp && npx vitest run src/agent/rca-prompts.test.ts 2>&1 | tail -20
```
Expected: All tests PASS.

**Step 5: Commit**

```bash
cd .worktrees/mvp && git add src/agent/rca-prompts.ts src/agent/rca-prompts.test.ts
git commit -m "feat: update RCA prompts and schemas to collect raw log samples and dashboard links"
```

---

### Task 3: Wire image capture in `investigation.ts`

**Files:**
- Modify: `src/agent/investigation.ts`

**Step 1: Change `runPhase` to return images alongside the result**

The `callTool` method on `McpClient` already returns `{ text, images: ImageContent[] }`. Currently `runPhase` ignores `.images`. We need to collect them.

Change the `runPhase` signature and return type:

```ts
private async runPhase<T>(
  systemPrompt: string,
  userMessage: string,
  responseFormat: ResponseFormat,
  maxIterations?: number,
  onTokenUsage?: (usage: TokenUsage) => void,
): Promise<{ result: T; images: ImageAttachment[] }>
```

Inside the tool call loop, collect images:

```ts
const collectedImages: ImageAttachment[] = [];

// inside the settled loop:
if (outcome.status === "fulfilled") {
  for (const img of outcome.value.images) {
    collectedImages.push({
      filename: `panel-${call.name}-${Date.now()}.png`,
      mimeType: img.mimeType,
      data: Buffer.from(img.data, "base64"),
    });
  }
}
```

At the end, change the text return to:
```ts
return { result: JSON.parse(response.content) as T, images: collectedImages };
```

**Step 2: Update all `runPhase` call sites in `investigate()`**

Phase 1 (anomaly detection) — change:
```ts
const result = await this.runPhase<AnomalyAssessment>(...);
anomaly = result;
```
to:
```ts
const { result } = await this.runPhase<AnomalyAssessment>(...);
anomaly = result;
```

Phases 2/3/4 — change:
```ts
const [metricResult, logResult, infraResult] = await Promise.allSettled([
  this.runPhase<MetricFindings>(...),
  this.runPhase<LogFindings>(...),
  this.runPhase<InfraFindings>(...),
]);

const metricFindings = metricResult.status === "fulfilled"
  ? metricResult.value
  : { ... };
```
to:
```ts
const [metricResult, logResult, infraResult] = await Promise.allSettled([
  this.runPhase<MetricFindings>(...),
  this.runPhase<LogFindings>(...),
  this.runPhase<InfraFindings>(...),
]);

const metricPhase = metricResult.status === "fulfilled"
  ? metricResult.value
  : { result: { observations: [], baseline: "unavailable", anomalyWindow: "unknown" }, images: [] };
const logPhase = logResult.status === "fulfilled"
  ? logResult.value
  : { result: { errorPatterns: [], stackTraces: [], logSamples: [], lokiSearchTerms: [], firstOccurrence: "unknown" }, images: [] };
const infraPhase = infraResult.status === "fulfilled"
  ? infraResult.value
  : { result: { podHealth: [], nodeHealth: [], recentEvents: [] }, images: [] };

const metricFindings = metricPhase.result;
const logFindings = logPhase.result;
const infraFindings = infraPhase.result;
const panelImages = [...metricPhase.images, ...logPhase.images];
```

Phase 5 (synthesis) — change:
```ts
const partial = await this.runPhase<Omit<RcaReport, "service" | "investigatedAt">>(...)
```
to:
```ts
const { result: partial } = await this.runPhase<Omit<RcaReport, "service" | "investigatedAt" | "panelImages">>(...)
```

Final return — add `panelImages`:
```ts
return {
  ...partial,
  service: service.name,
  investigatedAt: new Date().toISOString(),
  panelImages,
};
```

**Step 3: Run type check**

```bash
cd .worktrees/mvp && npx tsc --noEmit 2>&1 | head -30
```
Expected: No errors (or only errors in `App.tsx` which we fix next).

**Step 4: Commit**

```bash
cd .worktrees/mvp && git add src/agent/investigation.ts
git commit -m "feat: capture panel images from MCP tool calls in investigation phases"
```

---

### Task 4: Fix CLI renderer

**Files:**
- Modify: `src/interfaces/cli/App.tsx`
- Modify: `src/interfaces/cli/cli-utils.test.ts`

**Step 1: Write failing tests**

Add to the `formatRcaText` describe block in `src/interfaces/cli/cli-utils.test.ts`:

```ts
it("renders evidence metrics", () => {
  const text = formatRcaText({
    ...baseReport,
    evidence: { metrics: ["error_rate=15%"], logs: [], infra: [] },
    dashboardLinks: [],
    panelImages: [],
  });
  expect(text).toContain("Metrics:");
  expect(text).toContain("• error_rate=15%");
});

it("renders log samples", () => {
  const text = formatRcaText({
    ...baseReport,
    evidence: { metrics: [], logs: ["connection timeout"], infra: [] },
    dashboardLinks: [],
    panelImages: [],
  });
  expect(text).toContain("Logs:");
  expect(text).toContain("• connection timeout");
});

it("renders Loki search terms", () => {
  const report2: RcaReport = {
    ...baseReport,
    // LogFindings are not on RcaReport directly, but we test via a full report
    // that has lokiSearchTerms surfaced via the synthesis step.
    // For now, test that dashboardLinks render:
    dashboardLinks: ['https://grafana/d/abc?panelId=1'],
    panelImages: [],
  };
  const text = formatRcaText(report2);
  expect(text).toContain("Dashboard links:");
  expect(text).toContain("https://grafana/d/abc?panelId=1");
});

it("omits empty evidence sections", () => {
  const text = formatRcaText({
    ...baseReport,
    evidence: { metrics: [], logs: [], infra: [] },
    dashboardLinks: [],
    panelImages: [],
  });
  expect(text).not.toContain("Metrics:");
  expect(text).not.toContain("Logs:");
  expect(text).not.toContain("Dashboard links:");
});
```

**Note on Loki search terms:** `lokiSearchTerms` lives on `LogFindings` (an intermediate type used during investigation phases), not on `RcaReport` directly. The synthesis LLM is instructed to surface findings into `evidence.logs`. So the Loki terms will appear in `evidence.logs` as strings. No extra field needed on `RcaReport` for this — the LLM formats them inline.

**Step 2: Run tests to verify they fail**

```bash
cd .worktrees/mvp && npx vitest run src/interfaces/cli/cli-utils.test.ts 2>&1 | tail -20
```
Expected: New tests FAIL.

**Step 3: Update `formatRcaText` in `App.tsx`**

Replace the existing `formatRcaText` function:

```ts
export function formatRcaText(report: RcaReport): string {
  const severityEmoji: Record<string, string> = {
    low: "🟢", medium: "🟡", high: "🟠", critical: "🔴",
  };
  const emoji = severityEmoji[report.severity] ?? "⚪";

  const lines: string[] = [
    `${emoji} RCA Report: ${report.service}`,
    `Severity: ${report.severity} | Confidence: ${report.confidence}`,
    `Root cause: ${report.rootCause}`,
    `Summary: ${report.summary}`,
  ];

  const evidenceSections: string[] = [];
  if (report.evidence.metrics.length > 0) {
    evidenceSections.push(
      `  Metrics:\n${report.evidence.metrics.map((m) => `    • ${m}`).join("\n")}`,
    );
  }
  if (report.evidence.logs.length > 0) {
    evidenceSections.push(
      `  Logs:\n${report.evidence.logs.map((l) => `    • ${l}`).join("\n")}`,
    );
  }
  if (report.evidence.infra.length > 0) {
    evidenceSections.push(
      `  Infrastructure:\n${report.evidence.infra.map((i) => `    • ${i}`).join("\n")}`,
    );
  }
  if (report.dashboardLinks.length > 0) {
    evidenceSections.push(
      `  Dashboard links:\n${report.dashboardLinks.map((l) => `    • ${l}`).join("\n")}`,
    );
  }
  if (evidenceSections.length > 0) {
    lines.push(`Evidence:\n${evidenceSections.join("\n")}`);
  }

  if (report.recommendedActions.length > 0) {
    const actions = report.recommendedActions
      .map((a, i) => `  ${i + 1}. ${a}`)
      .join("\n");
    lines.push(`Actions:\n${actions}`);
  }

  lines.push(`Investigated at: ${report.investigatedAt}`);

  return lines.filter(Boolean).join("\n");
}
```

**Step 4: Wire panel images in `handleSubmit`**

In `App.tsx`, find the investigation branch and add image handling after `addMessage`:

```ts
const report = await investigationAgent.investigate(service, undefined, correlationId, onTokenUsage);
addMessage({ id: randomUUID(), role: "rca", content: formatRcaText(report) });

// Open panel images if any were captured
if (report.panelImages.length > 0) {
  const paths = saveAndOpenImages(report.panelImages);
  for (const p of paths) {
    addMessage({ id: randomUUID(), role: "image", content: `📎 Panel image: ${p} (opened)` });
  }
}
```

**Step 5: Run tests**

```bash
cd .worktrees/mvp && npx vitest run src/interfaces/cli/cli-utils.test.ts 2>&1 | tail -20
```
Expected: All tests PASS.

**Step 6: Run all tests**

```bash
cd .worktrees/mvp && npx vitest run 2>&1 | tail -30
```
Expected: All tests PASS.

**Step 7: Type check**

```bash
cd .worktrees/mvp && npx tsc --noEmit 2>&1
```
Expected: No errors.

**Step 8: Commit**

```bash
cd .worktrees/mvp && git add src/interfaces/cli/App.tsx src/interfaces/cli/cli-utils.test.ts
git commit -m "feat: render evidence, dashboard links, and panel images in CLI RCA output"
```

---

## Summary

| Task | Files | What changes |
|------|-------|-------------|
| 1 | `rca-types.ts` | Add `logSamples`, `lokiSearchTerms` to `LogFindings`; add `dashboardLinks`, `panelImages` to `RcaReport` |
| 2 | `rca-prompts.ts` | Update schemas + prompts to collect raw logs and dashboard URLs |
| 3 | `investigation.ts` | `runPhase` collects images from MCP tool results; wired into `RcaReport` |
| 4 | `App.tsx` | `formatRcaText` renders all evidence fields; panel images opened on macOS |

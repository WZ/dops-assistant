# RCA Investigation Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a 5-phase autonomous root cause analysis pipeline that investigates anomalies across metrics, logs, and infra — triggered automatically by the scheduler and on-demand from Slack.

**Architecture:** A new `InvestigationAgent` runs phases 1 (anomaly detect) → 2/3/4 (metric/log/infra in parallel) → 5 (synthesis). An `IntentClassifier` routes Slack messages to either investigation or existing conversational mode. Both wire into the existing `Scheduler` and `SlackBot` with minimal changes to those classes.

**Tech Stack:** TypeScript, OpenAI structured output (json_schema), existing `LlmClient` + `McpClient`, Slack Block Kit, Vitest.

---

## Reference: Key Existing Files

- `src/agent/core.ts` — AgentCore, tool-call loop pattern to follow
- `src/agent/types.ts` — AgentMode, AgentTask, AnomalyAssessment
- `src/agent/prompts.ts` — buildSystemPrompt, ANOMALY_ASSESSMENT_RESPONSE_FORMAT pattern
- `src/llm/openai.ts` — LlmClient, Message, LlmResponse types
- `src/mcp/client.ts` — McpClient, getTools(), callTool()
- `src/scheduler/scheduler.ts` — checkService(), AlertDeduplicator
- `src/interfaces/slack.ts` — SlackBot, handleMessage()
- `src/notifications/slack-webhook.ts` — AnomalyAlert, sendAnomalyAlert(), KnownBlock pattern
- `src/config/schema.ts` — AgentSchema (add investigationTriggerPhrases here)
- `src/index.ts` — wires everything, needs InvestigationAgent + IntentClassifier added

Run tests: `npm test`
TypeScript check: `npx tsc --noEmit`

---

## Task 1: RCA Types

**Files:**
- Create: `src/agent/rca-types.ts`
- No test file needed (pure type declarations)

**Step 1: Create the file**

```typescript
// src/agent/rca-types.ts

export type MetricFindings = {
  observations: string[];  // key metric values with timestamps
  baseline: string;        // normal range for comparison
  anomalyWindow: string;   // when the anomaly started
};

export type LogFindings = {
  errorPatterns: string[];  // recurring error messages
  stackTraces: string[];    // relevant stack traces
  firstOccurrence: string;  // ISO timestamp or "unknown"
};

export type InfraFindings = {
  podHealth: string[];    // restarts, OOMKilled, CrashLoopBackOff
  nodeHealth: string[];   // CPU/memory pressure
  recentEvents: string[]; // k8s events, alerts
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
  recommendedActions: string[];
  confidence: "low" | "medium" | "high";
  investigatedAt: string;
};

export type InvestigationIntent =
  | { intent: "investigation"; service?: string }
  | { intent: "question" };
```

**Step 2: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: clean (or only the pre-existing slack-webhook.test.ts error)

**Step 3: Commit**

```bash
git add src/agent/rca-types.ts
git commit -m "feat: add RCA types"
```

---

## Task 2: RCA Prompts and JSON Schemas

**Files:**
- Create: `src/agent/rca-prompts.ts`
- Create: `src/agent/rca-prompts.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/agent/rca-prompts.test.ts
import { describe, it, expect } from "vitest";
import {
  METRIC_DEEP_DIVE_PROMPT,
  LOG_CORRELATION_PROMPT,
  INFRA_HEALTH_PROMPT,
  RCA_SYNTHESIS_PROMPT,
  INTENT_CLASSIFIER_PROMPT,
  METRIC_FINDINGS_SCHEMA,
  LOG_FINDINGS_SCHEMA,
  INFRA_FINDINGS_SCHEMA,
  RCA_REPORT_SCHEMA,
  INTENT_RESPONSE_FORMAT,
} from "./rca-prompts.js";

describe("RCA prompts", () => {
  it("METRIC_DEEP_DIVE_PROMPT instructs metric analysis", () => {
    expect(METRIC_DEEP_DIVE_PROMPT).toContain("metrics");
    expect(METRIC_DEEP_DIVE_PROMPT).toContain("JSON");
  });

  it("LOG_CORRELATION_PROMPT instructs log analysis", () => {
    expect(LOG_CORRELATION_PROMPT).toContain("logs");
    expect(LOG_CORRELATION_PROMPT).toContain("JSON");
  });

  it("INFRA_HEALTH_PROMPT instructs infra analysis", () => {
    expect(INFRA_HEALTH_PROMPT).toContain("pod");
    expect(INFRA_HEALTH_PROMPT).toContain("JSON");
  });

  it("RCA_SYNTHESIS_PROMPT instructs root cause synthesis", () => {
    expect(RCA_SYNTHESIS_PROMPT).toContain("root cause");
    expect(RCA_SYNTHESIS_PROMPT).toContain("JSON");
  });

  it("INTENT_CLASSIFIER_PROMPT instructs intent classification", () => {
    expect(INTENT_CLASSIFIER_PROMPT).toContain("investigation");
    expect(INTENT_CLASSIFIER_PROMPT).toContain("JSON");
  });

  it("METRIC_FINDINGS_SCHEMA has required fields", () => {
    const schema = METRIC_FINDINGS_SCHEMA.json_schema.schema as { required: string[] };
    expect(schema.required).toContain("observations");
    expect(schema.required).toContain("baseline");
    expect(schema.required).toContain("anomalyWindow");
  });

  it("RCA_REPORT_SCHEMA has required fields", () => {
    const schema = RCA_REPORT_SCHEMA.json_schema.schema as { required: string[] };
    expect(schema.required).toContain("rootCause");
    expect(schema.required).toContain("confidence");
    expect(schema.required).toContain("recommendedActions");
    expect(schema.required).toContain("evidence");
  });
});
```

**Step 2: Run to confirm failure**

Run: `npm test -- src/agent/rca-prompts.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Implement**

```typescript
// src/agent/rca-prompts.ts
import type OpenAI from "openai";

// ── Phase prompts ─────────────────────────────────────────────────────────────

export const METRIC_DEEP_DIVE_PROMPT = `You are investigating a service anomaly. Your job is to deeply analyse the metrics for the affected service.
Query the metrics to determine:
- What values are currently abnormal (include exact numbers and timestamps)
- What the baseline/normal range appears to be
- When the anomaly window started

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const LOG_CORRELATION_PROMPT = `You are investigating a service anomaly. Query the recent logs for the affected service to find:
- Recurring error messages or exception patterns
- Stack traces or relevant error details
- When the errors first appeared

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const INFRA_HEALTH_PROMPT = `You are investigating a service anomaly. Check the infrastructure health for the affected service:
- Pod restart counts, OOMKilled events, CrashLoopBackOff status
- Node CPU or memory pressure
- Recent Kubernetes events or active alerts

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const RCA_SYNTHESIS_PROMPT = `You are performing root cause analysis. Based on the metric, log, and infrastructure findings provided, identify the root cause of the anomaly.
Determine the confidence level based on evidence quality:
- high: all 3 evidence types present and consistent
- medium: 2 of 3 evidence types, or suggestive but not conclusive
- low: only 1 evidence type, or contradictory findings

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

export const INTENT_CLASSIFIER_PROMPT = `You are classifying a user message as either an investigation request or a regular question.
An investigation request asks you to diagnose, investigate, or find the root cause of an issue with a specific service.
A question asks for information, data, or status.

Extract the service name if mentioned. Common patterns: "investigate X", "why is X slow", "X is down", "what's wrong with X".

Respond ONLY with valid JSON matching the required schema. Do not include any other text.`;

// ── JSON schemas ──────────────────────────────────────────────────────────────

export const METRIC_FINDINGS_SCHEMA: OpenAI.ResponseFormatJSONSchema = {
  type: "json_schema",
  json_schema: {
    name: "metric_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        observations: { type: "array", items: { type: "string" } },
        baseline: { type: "string" },
        anomalyWindow: { type: "string" },
      },
      required: ["observations", "baseline", "anomalyWindow"],
      additionalProperties: false,
    },
  },
};

export const LOG_FINDINGS_SCHEMA: OpenAI.ResponseFormatJSONSchema = {
  type: "json_schema",
  json_schema: {
    name: "log_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        errorPatterns: { type: "array", items: { type: "string" } },
        stackTraces: { type: "array", items: { type: "string" } },
        firstOccurrence: { type: "string" },
      },
      required: ["errorPatterns", "stackTraces", "firstOccurrence"],
      additionalProperties: false,
    },
  },
};

export const INFRA_FINDINGS_SCHEMA: OpenAI.ResponseFormatJSONSchema = {
  type: "json_schema",
  json_schema: {
    name: "infra_findings",
    strict: true,
    schema: {
      type: "object",
      properties: {
        podHealth: { type: "array", items: { type: "string" } },
        nodeHealth: { type: "array", items: { type: "string" } },
        recentEvents: { type: "array", items: { type: "string" } },
      },
      required: ["podHealth", "nodeHealth", "recentEvents"],
      additionalProperties: false,
    },
  },
};

export const RCA_REPORT_SCHEMA: OpenAI.ResponseFormatJSONSchema = {
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
        recommendedActions: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["severity", "summary", "rootCause", "evidence", "recommendedActions", "confidence"],
      additionalProperties: false,
    },
  },
};

export const INTENT_RESPONSE_FORMAT: OpenAI.ResponseFormatJSONSchema = {
  type: "json_schema",
  json_schema: {
    name: "intent_classification",
    strict: true,
    schema: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["investigation", "question"] },
        service: { type: "string" },
      },
      required: ["intent", "service"],
      additionalProperties: false,
    },
  },
};
```

**Step 4: Run tests**

Run: `npm test -- src/agent/rca-prompts.test.ts`
Expected: 7 tests passing

**Step 5: Commit**

```bash
git add src/agent/rca-prompts.ts src/agent/rca-prompts.test.ts
git commit -m "feat: add RCA prompts and JSON schemas"
```

---

## Task 3: InvestigationAgent

**Files:**
- Create: `src/agent/investigation.ts`
- Create: `src/agent/investigation.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/agent/investigation.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { InvestigationAgent } from "./investigation.js";
import type { LlmClient } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import type { AnomalyAssessment } from "./types.js";
import type { RcaReport } from "./rca-types.js";

const mockTools = [{ type: "function" as const, function: { name: "query_prometheus", description: "", parameters: {} } }];

const mockMcp = {
  getTools: vi.fn().mockReturnValue(mockTools),
  callTool: vi.fn().mockResolvedValue("metric data"),
  isConnected: vi.fn().mockReturnValue(true),
} as unknown as McpClient;

const baseMetricFindings = JSON.stringify({ observations: ["error_rate: 18%"], baseline: "0.2%", anomalyWindow: "14:32 UTC" });
const baseLogFindings = JSON.stringify({ errorPatterns: ["connection timeout"], stackTraces: [], firstOccurrence: "14:30 UTC" });
const baseInfraFindings = JSON.stringify({ podHealth: ["restarted 3x"], nodeHealth: [], recentEvents: [] });
const baseRcaReport = JSON.stringify({
  severity: "high",
  summary: "High error rate",
  rootCause: "DB connection pool exhausted",
  evidence: { metrics: ["error_rate: 18%"], logs: ["connection timeout"], infra: ["restarted 3x"] },
  recommendedActions: ["Scale connection pool"],
  confidence: "high",
});

const service = { name: "payments-api", metrics: [{ query: 'rate(errors[5m])', description: "error rate" }], logLabels: { app: "payments-api" } };

const anomaly: AnomalyAssessment = {
  isAnomaly: true,
  severity: "high",
  summary: "High error rate",
  affectedMetrics: ["error_rate"],
  recommendedAction: "Investigate",
};

function makeMockLlm(responses: string[]): LlmClient {
  let call = 0;
  return {
    chat: vi.fn().mockImplementation(() =>
      Promise.resolve({ type: "text", content: responses[call++] ?? "{}" })
    ),
  } as unknown as LlmClient;
}

describe("InvestigationAgent", () => {
  it("runs phases 2/3/4 in parallel and synthesises into RcaReport", async () => {
    const llm = makeMockLlm([baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly, "corr-001");

    expect(report.service).toBe("payments-api");
    expect(report.rootCause).toBe("DB connection pool exhausted");
    expect(report.confidence).toBe("high");
    expect(report.investigatedAt).toBeDefined();
    // LLM called 4 times: phases 2, 3, 4 (parallel) + phase 5
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(4);
  });

  it("runs phase 1 (anomaly detection) when no initial anomaly provided", async () => {
    const proactiveResponse = JSON.stringify({
      isAnomaly: true, severity: "high", summary: "High error rate",
      affectedMetrics: ["error_rate"], recommendedAction: "Investigate",
    });
    const llm = makeMockLlm([proactiveResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, undefined, "corr-002");

    expect(report.service).toBe("payments-api");
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(5);
  });

  it("returns no-anomaly report when phase 1 finds nothing", async () => {
    const noAnomalyResponse = JSON.stringify({
      isAnomaly: false, severity: "low", summary: "Service healthy",
      affectedMetrics: [], recommendedAction: "None",
    });
    const llm = makeMockLlm([noAnomalyResponse]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, undefined);

    expect(report.rootCause).toBe("No anomaly detected");
    expect(report.confidence).toBe("high");
    expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("degrades gracefully when a parallel phase fails", async () => {
    const failingLlm = {
      chat: vi.fn()
        .mockResolvedValueOnce({ type: "text", content: baseMetricFindings })
        .mockRejectedValueOnce(new Error("Loki unavailable"))  // log phase fails
        .mockResolvedValueOnce({ type: "text", content: baseInfraFindings })
        .mockResolvedValueOnce({ type: "text", content: baseRcaReport }),
    } as unknown as LlmClient;
    const agent = new InvestigationAgent(failingLlm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly);

    // Should still complete with empty log findings
    expect(report.service).toBe("payments-api");
    expect(report.evidence.logs).toEqual([]);
  });
});
```

**Step 2: Run to confirm failure**

Run: `npm test -- src/agent/investigation.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Implement**

```typescript
// src/agent/investigation.ts
import type { LlmClient, Message } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import type { ServiceConfig } from "../config/schema.js";
import type { AnomalyAssessment } from "./types.js";
import type { MetricFindings, LogFindings, InfraFindings, RcaReport } from "./rca-types.js";
import type OpenAI from "openai";
import {
  METRIC_DEEP_DIVE_PROMPT,
  LOG_CORRELATION_PROMPT,
  INFRA_HEALTH_PROMPT,
  RCA_SYNTHESIS_PROMPT,
  METRIC_FINDINGS_SCHEMA,
  LOG_FINDINGS_SCHEMA,
  INFRA_FINDINGS_SCHEMA,
  RCA_REPORT_SCHEMA,
} from "./rca-prompts.js";
import { buildProactiveStructuredPrompt, ANOMALY_ASSESSMENT_RESPONSE_FORMAT } from "./prompts.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export class InvestigationAgent {
  private readonly llm: LlmClient;
  private readonly mcp: McpClient;
  private readonly maxIterations: number;

  constructor(llm: LlmClient, mcp: McpClient, opts: { maxIterations: number }) {
    this.llm = llm;
    this.mcp = mcp;
    this.maxIterations = opts.maxIterations;
  }

  async investigate(
    service: ServiceConfig,
    initialAnomaly?: AnomalyAssessment,
    correlationId?: string,
  ): Promise<RcaReport> {
    const log = logger.child({ component: "investigation", service: service.name, correlationId });

    // Phase 1: detect anomaly if not provided
    let anomaly = initialAnomaly;
    if (!anomaly) {
      log.debug("Running phase 1: anomaly detection");
      const result = await this.runPhase<AnomalyAssessment>(
        buildProactiveStructuredPrompt([service]),
        `Check service: ${service.name}`,
        ANOMALY_ASSESSMENT_RESPONSE_FORMAT,
      );
      anomaly = result;
    }

    if (!anomaly.isAnomaly) {
      log.info("No anomaly detected, skipping investigation");
      return {
        service: service.name,
        severity: "low",
        summary: anomaly.summary,
        rootCause: "No anomaly detected",
        evidence: { metrics: [], logs: [], infra: [] },
        recommendedActions: [],
        confidence: "high",
        investigatedAt: new Date().toISOString(),
      };
    }

    log.debug("Running phases 2/3/4 in parallel");
    const anomalyContext = `Known issue: ${anomaly.summary} (severity: ${anomaly.severity})`;
    const metricMessage = `${anomalyContext}\nService metrics: ${service.metrics.map((m) => m.query).join(", ")}`;
    const logMessage = `${anomalyContext}\nLog labels: ${JSON.stringify(service.logLabels)}`;
    const infraMessage = `${anomalyContext}\nService: ${service.name}`;

    const [metricResult, logResult, infraResult] = await Promise.allSettled([
      this.runPhase<MetricFindings>(METRIC_DEEP_DIVE_PROMPT, metricMessage, METRIC_FINDINGS_SCHEMA),
      this.runPhase<LogFindings>(LOG_CORRELATION_PROMPT, logMessage, LOG_FINDINGS_SCHEMA),
      this.runPhase<InfraFindings>(INFRA_HEALTH_PROMPT, infraMessage, INFRA_FINDINGS_SCHEMA),
    ]);

    const metricFindings = metricResult.status === "fulfilled"
      ? metricResult.value
      : { observations: [], baseline: "unavailable", anomalyWindow: "unknown" };
    const logFindings = logResult.status === "fulfilled"
      ? logResult.value
      : { errorPatterns: [], stackTraces: [], firstOccurrence: "unknown" };
    const infraFindings = infraResult.status === "fulfilled"
      ? infraResult.value
      : { podHealth: [], nodeHealth: [], recentEvents: [] };

    if (metricResult.status === "rejected") log.warn({ err: metricResult.reason }, "Metric phase failed");
    if (logResult.status === "rejected") log.warn({ err: logResult.reason }, "Log phase failed");
    if (infraResult.status === "rejected") log.warn({ err: infraResult.reason }, "Infra phase failed");

    // Phase 5: synthesise
    log.debug("Running phase 5: synthesis");
    const synthesisMessage = [
      `Service: ${service.name}`,
      `Initial anomaly: ${JSON.stringify(anomaly)}`,
      `Metric findings: ${JSON.stringify(metricFindings)}`,
      `Log findings: ${JSON.stringify(logFindings)}`,
      `Infrastructure findings: ${JSON.stringify(infraFindings)}`,
    ].join("\n");

    const partial = await this.runPhase<Omit<RcaReport, "service" | "investigatedAt">>(
      RCA_SYNTHESIS_PROMPT,
      synthesisMessage,
      RCA_REPORT_SCHEMA,
      3,
    );

    return {
      ...partial,
      service: service.name,
      investigatedAt: new Date().toISOString(),
    };
  }

  private async runPhase<T>(
    systemPrompt: string,
    userMessage: string,
    responseFormat: OpenAI.ResponseFormatJSONSchema,
    maxIterations = this.maxIterations,
  ): Promise<T> {
    const tools = this.mcp.getTools();
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    for (let i = 0; i < maxIterations; i++) {
      const response = await this.llm.chat(messages, tools, { responseFormat });

      if (response.type === "text") {
        return JSON.parse(response.content) as T;
      }

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: response.calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });

      const settled = await Promise.allSettled(
        response.calls.map((call) => this.mcp.callTool(call.name, call.args)),
      );
      for (let j = 0; j < response.calls.length; j++) {
        const outcome = settled[j]!;
        const call = response.calls[j]!;
        messages.push({
          role: "tool",
          content: outcome.status === "fulfilled"
            ? outcome.value
            : `[Transport Error] ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          tool_call_id: call.id,
        });
      }
    }

    throw new Error(`Phase did not complete within ${maxIterations} iterations`);
  }
}
```

**Step 4: Run tests**

Run: `npm test -- src/agent/investigation.test.ts`
Expected: 4 tests passing

**Step 5: Run all tests**

Run: `npm test`
Expected: all passing

**Step 6: Commit**

```bash
git add src/agent/investigation.ts src/agent/investigation.test.ts
git commit -m "feat: add InvestigationAgent with 5-phase RCA pipeline"
```

---

## Task 4: IntentClassifier

**Files:**
- Create: `src/agent/intent.ts`
- Create: `src/agent/intent.test.ts`

**Step 1: Write failing tests**

```typescript
// src/agent/intent.test.ts
import { describe, it, expect, vi } from "vitest";
import { IntentClassifier } from "./intent.js";
import type { LlmClient } from "../llm/openai.js";

function makeLlm(response: string): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({ type: "text", content: response }),
  } as unknown as LlmClient;
}

describe("IntentClassifier", () => {
  it("classifies investigation intent with service name", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "investigation", service: "payments-api" }));
    const classifier = new IntentClassifier(llm);
    const result = await classifier.classify("investigate payments-api");
    expect(result.intent).toBe("investigation");
    if (result.intent === "investigation") {
      expect(result.service).toBe("payments-api");
    }
  });

  it("classifies question intent", async () => {
    const llm = makeLlm(JSON.stringify({ intent: "question", service: "" }));
    const classifier = new IntentClassifier(llm);
    const result = await classifier.classify("what is the error rate?");
    expect(result.intent).toBe("question");
  });

  it("falls back to question on parse error", async () => {
    const llm = makeLlm("not valid json");
    const classifier = new IntentClassifier(llm);
    const result = await classifier.classify("investigate something");
    expect(result.intent).toBe("question");
  });

  it("falls back to question on LLM error", async () => {
    const llm = {
      chat: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    } as unknown as LlmClient;
    const classifier = new IntentClassifier(llm);
    const result = await classifier.classify("is payments down?");
    expect(result.intent).toBe("question");
  });
});
```

**Step 2: Run to confirm failure**

Run: `npm test -- src/agent/intent.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Implement**

```typescript
// src/agent/intent.ts
import type { LlmClient } from "../llm/openai.js";
import type { InvestigationIntent } from "./rca-types.js";
import { INTENT_CLASSIFIER_PROMPT, INTENT_RESPONSE_FORMAT } from "./rca-prompts.js";

export class IntentClassifier {
  private readonly llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async classify(message: string): Promise<InvestigationIntent> {
    try {
      const response = await this.llm.chat(
        [
          { role: "system", content: INTENT_CLASSIFIER_PROMPT },
          { role: "user", content: message },
        ],
        [], // no tools needed for classification
        { responseFormat: INTENT_RESPONSE_FORMAT },
      );

      if (response.type !== "text") return { intent: "question" };

      const parsed = JSON.parse(response.content) as { intent: string; service: string };
      if (parsed.intent === "investigation") {
        return {
          intent: "investigation",
          service: parsed.service || undefined,
        };
      }
      return { intent: "question" };
    } catch {
      return { intent: "question" };
    }
  }
}
```

**Step 4: Run tests**

Run: `npm test -- src/agent/intent.test.ts`
Expected: 4 tests passing

**Step 5: Commit**

```bash
git add src/agent/intent.ts src/agent/intent.test.ts
git commit -m "feat: add IntentClassifier"
```

---

## Task 5: RCA Slack Blocks Formatter

**Files:**
- Create: `src/notifications/rca-blocks.ts`
- Create: `src/notifications/rca-blocks.test.ts`

**Step 1: Write failing tests**

```typescript
// src/notifications/rca-blocks.test.ts
import { describe, it, expect } from "vitest";
import { formatRcaBlocks } from "./rca-blocks.js";
import type { RcaReport } from "../agent/rca-types.js";

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
  recommendedActions: ["Scale connection pool", "Restart pods"],
  confidence: "high",
  investigatedAt: "2026-02-25T14:37:00.000Z",
};

describe("formatRcaBlocks", () => {
  it("includes service name and severity in header", () => {
    const blocks = formatRcaBlocks(report);
    const header = blocks.find((b) => b.type === "header");
    expect(JSON.stringify(header)).toContain("payments-api");
    expect(JSON.stringify(header)).toContain("high");
  });

  it("includes root cause section", () => {
    const blocks = formatRcaBlocks(report);
    const text = JSON.stringify(blocks);
    expect(text).toContain("DB connection pool exhausted");
  });

  it("includes all evidence types", () => {
    const blocks = formatRcaBlocks(report);
    const text = JSON.stringify(blocks);
    expect(text).toContain("error_rate: 18%");
    expect(text).toContain("connection timeout");
    expect(text).toContain("pod restarted");
  });

  it("includes recommended actions", () => {
    const blocks = formatRcaBlocks(report);
    const text = JSON.stringify(blocks);
    expect(text).toContain("Scale connection pool");
    expect(text).toContain("Restart pods");
  });

  it("includes confidence and timestamp", () => {
    const blocks = formatRcaBlocks(report);
    const text = JSON.stringify(blocks);
    expect(text).toContain("high");
    expect(text).toContain("14:37");
  });

  it("omits empty evidence sections", () => {
    const sparseReport: RcaReport = {
      ...report,
      evidence: { metrics: ["metric: 18%"], logs: [], infra: [] },
    };
    const blocks = formatRcaBlocks(sparseReport);
    const text = JSON.stringify(blocks);
    expect(text).not.toContain("Logs");
    expect(text).not.toContain("Infrastructure");
  });
});
```

**Step 2: Run to confirm failure**

Run: `npm test -- src/notifications/rca-blocks.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Implement**

```typescript
// src/notifications/rca-blocks.ts
import type { KnownBlock } from "@slack/bolt";
import type { RcaReport } from "../agent/rca-types.js";

const SEVERITY_EMOJI: Record<RcaReport["severity"], string> = {
  low: ":yellow_circle:",
  medium: ":orange_circle:",
  high: ":red_circle:",
  critical: ":rotating_light:",
};

const CONFIDENCE_LABEL: Record<RcaReport["confidence"], string> = {
  low: ":low_brightness: low",
  medium: ":medium_brightness: medium",
  high: ":high_brightness: high",
};

export function formatRcaBlocks(report: RcaReport): KnownBlock[] {
  const time = new Date(report.investigatedAt).toISOString().slice(11, 16) + " UTC";

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${SEVERITY_EMOJI[report.severity]} [${report.severity}] ${report.service} — ${report.summary}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Root Cause*\n${report.rootCause}` },
    },
  ];

  const evidenceLines: string[] = [];
  if (report.evidence.metrics.length > 0) {
    evidenceLines.push(`*Metrics*\n${report.evidence.metrics.map((m) => `• ${m}`).join("\n")}`);
  }
  if (report.evidence.logs.length > 0) {
    evidenceLines.push(`*Logs*\n${report.evidence.logs.map((l) => `• ${l}`).join("\n")}`);
  }
  if (report.evidence.infra.length > 0) {
    evidenceLines.push(`*Infrastructure*\n${report.evidence.infra.map((i) => `• ${i}`).join("\n")}`);
  }

  if (evidenceLines.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Evidence*\n${evidenceLines.join("\n\n")}` },
    });
  }

  if (report.recommendedActions.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recommended Actions*\n${report.recommendedActions.map((a, i) => `${i + 1}. ${a}`).join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Confidence: ${CONFIDENCE_LABEL[report.confidence]}  |  Investigated at ${time}`,
      },
    ],
  });

  return blocks;
}
```

**Step 4: Run tests**

Run: `npm test -- src/notifications/rca-blocks.test.ts`
Expected: 6 tests passing

**Step 5: Commit**

```bash
git add src/notifications/rca-blocks.ts src/notifications/rca-blocks.test.ts
git commit -m "feat: add RCA Slack Block Kit formatter"
```

---

## Task 6: Wire InvestigationAgent into Scheduler

**Files:**
- Modify: `src/scheduler/scheduler.ts`
- Modify: `src/scheduler/scheduler.test.ts`

**Current `checkService()` in `scheduler.ts`** (lines ~131-186): after determining `assessment.isAnomaly === true` and `deduplicator.shouldAlert()`, it builds `AnomalyAlert` and calls `this.notify()`. We insert `InvestigationAgent.investigate()` between anomaly detection and alerting.

**Step 1: Write failing tests — add to existing test file**

Add this describe block to `src/scheduler/scheduler.test.ts`:

```typescript
// Add near end of scheduler.test.ts — after existing describe blocks
import type { InvestigationAgent } from "../agent/investigation.js";
import type { RcaReport } from "../agent/rca-types.js";

describe("Scheduler – RCA integration", () => {
  it("calls investigationAgent.investigate() when anomaly is detected", async () => {
    const mockReport: RcaReport = {
      service: "test-service",
      severity: "high",
      summary: "High error rate",
      rootCause: "DB pool exhausted",
      evidence: { metrics: ["rate: 18%"], logs: [], infra: [] },
      recommendedActions: ["Scale DB"],
      confidence: "high",
      investigatedAt: new Date().toISOString(),
    };
    const mockInvestigationAgent = {
      investigate: vi.fn().mockResolvedValue(mockReport),
    } as unknown as InvestigationAgent;

    const mockNotify = vi.fn().mockResolvedValue(undefined);
    const anomalyAssessment = JSON.stringify({
      isAnomaly: true, severity: "high", summary: "High error rate",
      affectedMetrics: ["error_rate"], recommendedAction: "Investigate",
    });
    mockAgent.run.mockResolvedValueOnce({ response: anomalyAssessment, updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "5m", maxConcurrency: 1, alertCooldownMinutes: 0 },
      [{ name: "test-service", metrics: [], logLabels: {} }],
      mockAgent,
      mockNotify,
      "https://hooks.slack.com/test",
      mockInvestigationAgent,
    );

    await scheduler.checkService({ name: "test-service", metrics: [], logLabels: {} });

    expect(mockInvestigationAgent.investigate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test-service" }),
      expect.objectContaining({ isAnomaly: true }),
      expect.any(String),
    );
    expect(mockNotify).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({ rca: mockReport }),
    );
  });

  it("still alerts even if investigation fails", async () => {
    const mockInvestigationAgent = {
      investigate: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    } as unknown as InvestigationAgent;

    const mockNotify = vi.fn().mockResolvedValue(undefined);
    const anomalyAssessment = JSON.stringify({
      isAnomaly: true, severity: "high", summary: "High error rate",
      affectedMetrics: ["error_rate"], recommendedAction: "Investigate",
    });
    mockAgent.run.mockResolvedValueOnce({ response: anomalyAssessment, updatedHistory: [] });

    const scheduler = new Scheduler(
      { interval: "5m", maxConcurrency: 1, alertCooldownMinutes: 0 },
      [{ name: "test-service", metrics: [], logLabels: {} }],
      mockAgent,
      mockNotify,
      "https://hooks.slack.com/test",
      mockInvestigationAgent,
    );

    await scheduler.checkService({ name: "test-service", metrics: [], logLabels: {} });

    // Alert still sent, just without rca field
    expect(mockNotify).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.not.objectContaining({ rca: expect.anything() }),
    );
  });
});
```

**Step 2: Run to confirm failure**

Run: `npm test -- src/scheduler/scheduler.test.ts`
Expected: FAIL — Scheduler constructor doesn't accept InvestigationAgent

**Step 3: Update `src/scheduler/scheduler.ts`**

Add `investigationAgent` as optional 6th constructor parameter. In `checkService()`, after anomaly detection and before building `AnomalyAlert`, call investigate and attach result:

```typescript
// Add import at top
import type { InvestigationAgent } from "../agent/investigation.js";
import type { RcaReport } from "../agent/rca-types.js";

// In Scheduler class, add field:
private investigationAgent?: InvestigationAgent;

// Update constructor signature:
constructor(
  config: AnomalyCheckConfig,
  services: ServiceConfig[],
  agent: AgentCore,
  notify: typeof sendAnomalyAlert,
  webhookUrl = "",
  investigationAgent?: InvestigationAgent,
) {
  // ... existing assignments ...
  this.investigationAgent = investigationAgent;
}

// In checkService(), replace the section after `schedulerChecksTotal.inc({ service: service.name, status: "anomaly" });`
// with this (insert before shouldAlert check):

schedulerChecksTotal.inc({ service: service.name, status: "anomaly" });

if (!this.deduplicator.shouldAlert(service.name)) {
  log.info("Anomaly detected but suppressed by cooldown");
  alertNotificationsTotal.inc({ status: "deduplicated" });
  return;
}

// Run RCA investigation if available
let rca: RcaReport | undefined;
if (this.investigationAgent) {
  try {
    rca = await this.investigationAgent.investigate(service, assessment, correlationId);
    log.info({ confidence: rca.confidence }, "RCA investigation complete");
  } catch (err) {
    log.warn({ err }, "RCA investigation failed, alerting without RCA");
  }
}

const alert: AnomalyAlert = {
  service: service.name,
  severity: assessment.severity,
  summary: assessment.summary,
  affectedMetrics: assessment.affectedMetrics,
  recommendedAction: assessment.recommendedAction,
  ...(rca ? { rca } : {}),
};
```

Also update `AnomalyAlert` type in `src/notifications/slack-webhook.ts` to add the optional `rca` field:

```typescript
// Add import at top of slack-webhook.ts:
import type { RcaReport } from "../agent/rca-types.js";

// Add to AnomalyAlert type:
export type AnomalyAlert = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  affectedMetrics?: string[];
  dashboardUrl?: string;
  recommendedAction?: string;
  rca?: RcaReport;  // ADD THIS
};
```

Also update `sendAnomalyAlert()` blocks to render RCA if present. After the existing `recommendedAction` block, add:

```typescript
if (alert.rca) {
  // Replace the existing blocks with RCA blocks when available
  const rcaBlocks = formatRcaBlocks(alert.rca);
  blocks.splice(0, blocks.length, ...rcaBlocks);
}
```

Add import: `import { formatRcaBlocks } from "./rca-blocks.js";`

**Step 4: Run tests**

Run: `npm test -- src/scheduler/scheduler.test.ts`
Expected: all passing including new tests

**Step 5: Run all tests**

Run: `npm test`
Expected: all passing

**Step 6: Commit**

```bash
git add src/scheduler/scheduler.ts src/scheduler/scheduler.test.ts src/notifications/slack-webhook.ts
git commit -m "feat: wire InvestigationAgent into Scheduler and enrich alerts with RCA"
```

---

## Task 7: Wire IntentClassifier into SlackBot

**Files:**
- Modify: `src/interfaces/slack.ts`
- Modify: `src/interfaces/slack.test.ts`

**Step 1: Write failing tests — add to existing test file**

Add to `src/interfaces/slack.test.ts`:

```typescript
// Add imports at top
import type { InvestigationAgent } from "../agent/investigation.js";
import type { IntentClassifier } from "../agent/intent.js";
import type { RcaReport } from "../agent/rca-types.js";

// Add mocks with vi.hoisted or at top of file alongside existing mocks
const mockRcaReport: RcaReport = {
  service: "payments-api",
  severity: "high",
  summary: "High error rate",
  rootCause: "DB pool exhausted",
  evidence: { metrics: ["18%"], logs: [], infra: [] },
  recommendedActions: ["Scale DB"],
  confidence: "high",
  investigatedAt: new Date().toISOString(),
};

// Add a new describe block:
describe("SlackBot – investigation routing", () => {
  it("routes investigation intent to InvestigationAgent", async () => {
    const mockClassifier = {
      classify: vi.fn().mockResolvedValue({ intent: "investigation", service: "payments-api" }),
    } as unknown as IntentClassifier;
    const mockInvestigationAgent = {
      investigate: vi.fn().mockResolvedValue(mockRcaReport),
    } as unknown as InvestigationAgent;

    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory,
      [],
      mockClassifier,
      mockInvestigationAgent,
    );

    await bot.handleMessage({ text: "investigate payments-api", threadTs: "ts1", userId: "U1" }, mockSay);

    expect(mockInvestigationAgent.investigate).toHaveBeenCalled();
    expect(mockAgent.run).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(expect.objectContaining({ blocks: expect.any(Array) }));
  });

  it("falls back to conversational mode for question intent", async () => {
    const mockClassifier = {
      classify: vi.fn().mockResolvedValue({ intent: "question" }),
    } as unknown as IntentClassifier;

    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory,
      [],
      mockClassifier,
    );

    await bot.handleMessage({ text: "what is the error rate?", threadTs: "ts1", userId: "U1" }, mockSay);

    expect(mockAgent.run).toHaveBeenCalled();
  });

  it("falls back to conversational mode when no classifier provided", async () => {
    const bot = new SlackBot(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      mockAgent,
      mockMemory,
    );

    await bot.handleMessage({ text: "hello", threadTs: "ts1", userId: "U1" }, mockSay);

    expect(mockAgent.run).toHaveBeenCalled();
  });
});
```

**Step 2: Run to confirm failure**

Run: `npm test -- src/interfaces/slack.test.ts`
Expected: FAIL — SlackBot constructor doesn't accept classifier/investigationAgent

**Step 3: Update `src/interfaces/slack.ts`**

Add `services`, `classifier`, `investigationAgent` as optional constructor parameters:

```typescript
// Add imports:
import type { InvestigationAgent } from "../agent/investigation.js";
import type { IntentClassifier } from "../agent/intent.js";
import type { ServiceConfig } from "../config/schema.js";
import { formatRcaBlocks } from "../notifications/rca-blocks.js";

// Update SlackBot class:
export class SlackBot {
  private app: App;
  private agent: AgentCore;
  private memory: ConversationMemory;
  private services: ServiceConfig[];
  private classifier?: IntentClassifier;
  private investigationAgent?: InvestigationAgent;

  constructor(
    config: SlackConfig,
    agent: AgentCore,
    memory: ConversationMemory,
    services: ServiceConfig[] = [],
    classifier?: IntentClassifier,
    investigationAgent?: InvestigationAgent,
  ) {
    this.agent = agent;
    this.memory = memory;
    this.services = services;
    this.classifier = classifier;
    this.investigationAgent = investigationAgent;
    this.app = new App({ token: config.botToken, appToken: config.appToken, socketMode: true });
    this.registerHandlers();
  }
```

Update `handleMessage()` to route via classifier:

```typescript
async handleMessage(
  ctx: MessageContext,
  say: (msg: object) => Promise<void>,
): Promise<void> {
  const correlationId = randomUUID().slice(0, 8);
  const threadId = ctx.threadTs;

  try {
    // Route via intent classifier if available
    if (this.classifier && this.investigationAgent) {
      const intent = await this.classifier.classify(ctx.text);
      if (intent.intent === "investigation") {
        const service = this.services.find((s) => s.name === intent.service)
          ?? this.services[0];

        if (!service) {
          await say({ text: "No services configured to investigate.", thread_ts: threadId });
          slackMessagesTotal.inc({ status: "success" });
          return;
        }

        const report = await this.investigationAgent.investigate(service, undefined, correlationId);
        await say({ blocks: formatRcaBlocks(report), thread_ts: threadId });
        slackMessagesTotal.inc({ status: "success" });
        return;
      }
    }

    // Existing conversational path
    const history = this.memory.get(threadId);
    this.memory.append(threadId, { role: "user", content: ctx.text });

    const result = await this.agent.run({
      mode: "conversational",
      message: ctx.text,
      history,
      correlationId,
    });
    this.memory.append(threadId, { role: "assistant", content: result.response });
    await say({ text: result.response, thread_ts: threadId });
    slackMessagesTotal.inc({ status: "success" });
  } catch (err) {
    slackMessagesTotal.inc({ status: "error" });
    await say({ text: "Sorry, something went wrong. Please try again.", thread_ts: threadId }).catch(() => undefined);
    throw err;
  }
}
```

**Step 4: Run tests**

Run: `npm test -- src/interfaces/slack.test.ts`
Expected: all passing including new tests

**Step 5: Run all tests**

Run: `npm test`
Expected: all passing

**Step 6: Commit**

```bash
git add src/interfaces/slack.ts src/interfaces/slack.test.ts
git commit -m "feat: route Slack messages via IntentClassifier to InvestigationAgent"
```

---

## Task 8: Update Config Schema and Wire in index.ts

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/schema.test.ts`
- Modify: `src/index.ts`

**Step 1: Add `investigationTriggerPhrases` to AgentSchema in `src/config/schema.ts`**

```typescript
// In schema.ts, update AgentSchema:
const AgentSchema = z.object({
  maxIterations: z.number().default(20),
  conversationMemory: ConversationMemorySchema.optional().default({}),
  investigationTriggerPhrases: z.array(z.string()).optional().default([
    "investigate",
    "why is",
    "what's wrong",
    "is down",
    "is slow",
    "root cause",
  ]),
});
```

**Step 2: Add to schema test**

In `src/config/schema.test.ts`, verify the default is applied:

```typescript
it("applies default investigationTriggerPhrases", () => {
  const result = ConfigSchema.safeParse({
    llm: { apiKey: "sk-test", model: "gpt-4", maxTokens: 4096 },
    grafana: { mcpServer: { transport: "stdio", command: "npx", args: [], env: {} } },
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.agent.investigationTriggerPhrases).toContain("investigate");
  }
});
```

**Step 3: Run schema test**

Run: `npm test -- src/config/schema.test.ts`
Expected: all passing

**Step 4: Wire in `src/index.ts`**

Add `InvestigationAgent`, `IntentClassifier` construction and pass to `Scheduler` and `SlackBot`:

```typescript
// Add imports in index.ts:
import { InvestigationAgent } from "./agent/investigation.js";
import { IntentClassifier } from "./agent/intent.js";

// After creating `agent` (AgentCore), add:
const investigationAgent = new InvestigationAgent(llm, mcp, {
  maxIterations: config.agent.maxIterations,
});
const classifier = new IntentClassifier(llm);

// Update Scheduler construction to pass investigationAgent (6th arg):
const scheduler = new Scheduler(
  config.scheduler.anomalyCheck,
  services,
  agent,
  sendAnomalyAlert,
  config.notifications.slack?.webhookUrl ?? "",
  investigationAgent,
);

// Update SlackBot construction:
const slackBot = new SlackBot(
  config.interfaces.slack,
  agent,
  memory,
  services,
  classifier,
  investigationAgent,
);
```

**Step 5: Run all tests**

Run: `npm test`
Expected: all passing

**Step 6: TypeScript check**

Run: `npx tsc --noEmit`
Expected: clean

**Step 7: Commit**

```bash
git add src/config/schema.ts src/config/schema.test.ts src/index.ts
git commit -m "feat: add investigationTriggerPhrases config and wire InvestigationAgent + IntentClassifier in index"
```

---

## Final Verification

```bash
npm test
# Expected: all tests pass (145+ tests)

npx tsc --noEmit
# Expected: clean

docker compose -f docker-compose.dev.yml --project-name dops-assistant up --build
# Expected: builds and starts without error
```

Test end-to-end in Slack:
1. `@OpsAgent investigate payments-api` → should trigger RCA and return structured blocks
2. `@OpsAgent what is the error rate?` → should use existing conversational mode

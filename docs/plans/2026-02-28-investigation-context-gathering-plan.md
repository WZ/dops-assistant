# Investigation Context-Gathering Pre-Phase Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a programmatic Phase 0 that gathers environment context, resolves Loki labels, and classifies services before the LLM-driven investigation phases begin.

**Architecture:** Three new self-contained modules (`env-context.ts`, `loki-resolver.ts`, `service-classifier.ts`) that are called from `investigation.ts` before existing phases. Phase prompts gain an optional `context` parameter to inject datasource UIDs and Loki selectors.

**Tech Stack:** TypeScript, Vitest, MCP client (`McpClient` from `src/mcp/client.ts`)

---

### Task 1: EnvironmentContext types and module

**Files:**
- Create: `src/agent/env-context.ts`
- Test: `src/agent/env-context.test.ts`

**Step 1: Write the failing test**

```typescript
// src/agent/env-context.test.ts
import { describe, it, expect, vi } from "vitest";
import { EnvironmentContextResolver } from "./env-context.js";
import type { McpClient } from "../mcp/client.js";

function makeMockMcp(datasourcesText: string, lokiQueryText: string): McpClient {
  return {
    callTool: vi.fn()
      .mockResolvedValueOnce({ text: datasourcesText, images: [] })  // list_datasources
      .mockResolvedValueOnce({ text: lokiQueryText, images: [] }),    // query_loki
  } as unknown as McpClient;
}

describe("EnvironmentContextResolver", () => {
  it("extracts datasource UIDs and Loki label keys", async () => {
    const datasources = JSON.stringify([
      { uid: "prom-uid-1", type: "prometheus", name: "Prometheus" },
      { uid: "loki-uid-1", type: "loki", name: "Loki" },
      { uid: "other-uid", type: "tempo", name: "Tempo" },
    ]);
    const lokiResult = JSON.stringify({
      data: { result: [{ stream: { app_fortidata_name: "test", job: "ns/svc", container_name: "main", host: "node1" } }] },
    });

    const mcp = makeMockMcp(datasources, lokiResult);
    const resolver = new EnvironmentContextResolver(mcp);
    const ctx = await resolver.resolve();

    expect(ctx.prometheusDatasourceUid).toBe("prom-uid-1");
    expect(ctx.lokiDatasourceUid).toBe("loki-uid-1");
    expect(ctx.lokiLabelKeys).toContain("app_fortidata_name");
    expect(ctx.lokiLabelKeys).toContain("job");
    expect(ctx.lokiLabelKeys).toContain("container_name");
  });

  it("caches result on second call", async () => {
    const datasources = JSON.stringify([
      { uid: "prom-1", type: "prometheus", name: "P" },
      { uid: "loki-1", type: "loki", name: "L" },
    ]);
    const lokiResult = JSON.stringify({ data: { result: [{ stream: { job: "ns/svc" } }] } });

    const mcp = makeMockMcp(datasources, lokiResult);
    const resolver = new EnvironmentContextResolver(mcp);

    const ctx1 = await resolver.resolve();
    const ctx2 = await resolver.resolve();

    expect(ctx1).toBe(ctx2); // same object reference = cached
    expect(mcp.callTool).toHaveBeenCalledTimes(2); // only 2 calls total, not 4
  });

  it("throws when Prometheus datasource not found", async () => {
    const datasources = JSON.stringify([{ uid: "loki-1", type: "loki", name: "L" }]);
    const mcp = makeMockMcp(datasources, "{}");
    const resolver = new EnvironmentContextResolver(mcp);

    await expect(resolver.resolve()).rejects.toThrow(/Prometheus/i);
  });

  it("throws when Loki datasource not found", async () => {
    const datasources = JSON.stringify([{ uid: "prom-1", type: "prometheus", name: "P" }]);
    const mcp = makeMockMcp(datasources, "{}");
    const resolver = new EnvironmentContextResolver(mcp);

    await expect(resolver.resolve()).rejects.toThrow(/Loki/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/env-context.test.ts`
Expected: FAIL — module doesn't exist yet.

**Step 3: Write the implementation**

```typescript
// src/agent/env-context.ts
import type { McpClient } from "../mcp/client.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export type EnvironmentContext = {
  prometheusDatasourceUid: string;
  lokiDatasourceUid: string;
  lokiLabelKeys: string[];
};

export class EnvironmentContextResolver {
  private readonly mcp: McpClient;
  private cached: EnvironmentContext | null = null;

  constructor(mcp: McpClient) {
    this.mcp = mcp;
  }

  async resolve(): Promise<EnvironmentContext> {
    if (this.cached) return this.cached;

    // Step 1: discover datasource UIDs
    const dsResult = await this.mcp.callTool("list_datasources", {});
    const datasources = JSON.parse(dsResult.text) as Array<{ uid: string; type: string; name: string }>;

    const prom = datasources.find((d) => d.type === "prometheus");
    if (!prom) throw new Error("Prometheus datasource not found");

    const loki = datasources.find((d) => d.type === "loki");
    if (!loki) throw new Error("Loki datasource not found");

    // Step 2: discover Loki label keys via a broad query
    let lokiLabelKeys: string[] = [];
    try {
      const lokiResult = await this.mcp.callTool("query_loki", {
        datasourceUid: loki.uid,
        lokiQuery: '{job=~".+"}',
        limit: 1,
      });
      const parsed = JSON.parse(lokiResult.text) as {
        data?: { result?: Array<{ stream?: Record<string, string> }> };
      };
      const stream = parsed?.data?.result?.[0]?.stream;
      if (stream) {
        lokiLabelKeys = Object.keys(stream);
      }
    } catch (err) {
      logger.warn({ err }, "Failed to discover Loki label keys, continuing with empty list");
    }

    this.cached = {
      prometheusDatasourceUid: prom.uid,
      lokiDatasourceUid: loki.uid,
      lokiLabelKeys,
    };

    logger.debug({ ctx: this.cached }, "Environment context resolved");
    return this.cached;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/env-context.test.ts`
Expected: 4 tests PASS.

**Step 5: Commit**

```bash
git add src/agent/env-context.ts src/agent/env-context.test.ts
git commit -m "feat: add EnvironmentContextResolver module for Phase 0"
```

---

### Task 2: LokiResolver module

**Files:**
- Create: `src/agent/loki-resolver.ts`
- Test: `src/agent/loki-resolver.test.ts`

**Step 1: Write the failing test**

```typescript
// src/agent/loki-resolver.test.ts
import { describe, it, expect, vi } from "vitest";
import { LokiResolver, stemServiceName } from "./loki-resolver.js";
import type { McpClient } from "../mcp/client.js";

describe("stemServiceName", () => {
  it("strips common suffixes", () => {
    expect(stemServiceName("kudu-tserver")).toBe("kudu");
    expect(stemServiceName("redis-server")).toBe("redis");
    expect(stemServiceName("hdfs-namenode")).toBe("hdfs");
    expect(stemServiceName("my-service")).toBe("my-service"); // no known suffix
    expect(stemServiceName("zookeeper")).toBe("zookeeper"); // no suffix
  });
});

describe("LokiResolver", () => {
  function makeMcp(hitOnCall: number): McpClient {
    let call = 0;
    return {
      callTool: vi.fn().mockImplementation(() => {
        call++;
        if (call === hitOnCall) {
          // Loki returns a result
          return Promise.resolve({
            text: JSON.stringify({ data: { result: [{ stream: { job: "ns/svc" }, values: [["ts", "log line"]] }] } }),
            images: [],
          });
        }
        // Loki returns empty
        return Promise.resolve({
          text: JSON.stringify({ data: { result: [] } }),
          images: [],
        });
      }),
    } as unknown as McpClient;
  }

  it("resolves on first cascade step (app_fortidata_name exact)", async () => {
    const mcp = makeMcp(1);
    const resolver = new LokiResolver(mcp, "loki-uid");
    const result = await resolver.resolve("my-service");

    expect(result).toEqual({ app_fortidata_name: "my-service" });
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
  });

  it("resolves on stem step (app_fortidata_name stem)", async () => {
    const mcp = makeMcp(2); // miss exact, hit stem
    const resolver = new LokiResolver(mcp, "loki-uid");
    const result = await resolver.resolve("kudu-tserver");

    expect(result).toEqual({ app_fortidata_name: "kudu" });
    expect(mcp.callTool).toHaveBeenCalledTimes(2);
  });

  it("resolves on job regex step", async () => {
    const mcp = makeMcp(3); // miss app_fortidata_name exact + stem, hit job exact
    const resolver = new LokiResolver(mcp, "loki-uid");
    const result = await resolver.resolve("my-service");

    // stem === name for "my-service" so step 2 is skipped, step 3 is job exact
    expect(result).toEqual({ job: expect.stringContaining("my-service") });
  });

  it("returns null when no cascade step hits", async () => {
    const mcp = makeMcp(-1); // never hits
    const resolver = new LokiResolver(mcp, "loki-uid");
    const result = await resolver.resolve("unknown-service");

    expect(result).toBeNull();
  });

  it("returns null on MCP error without throwing", async () => {
    const mcp = {
      callTool: vi.fn().mockRejectedValue(new Error("Loki unavailable")),
    } as unknown as McpClient;
    const resolver = new LokiResolver(mcp, "loki-uid");
    const result = await resolver.resolve("my-service");

    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/loki-resolver.test.ts`
Expected: FAIL — module doesn't exist yet.

**Step 3: Write the implementation**

```typescript
// src/agent/loki-resolver.ts
import type { McpClient } from "../mcp/client.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const KNOWN_SUFFIXES = ["-tserver", "-master", "-server", "-namenode", "-datanode", "-journalnode", "-worker", "-agent"];

export function stemServiceName(name: string): string {
  for (const suffix of KNOWN_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

type LokiSelector = Record<string, string>;

export class LokiResolver {
  private readonly mcp: McpClient;
  private readonly lokiUid: string;

  constructor(mcp: McpClient, lokiUid: string) {
    this.mcp = mcp;
    this.lokiUid = lokiUid;
  }

  async resolve(serviceName: string): Promise<LokiSelector | null> {
    const stem = stemServiceName(serviceName);

    // Build cascade: [query, selectorOnHit]
    const cascade: Array<[string, LokiSelector]> = [
      [`{app_fortidata_name="${serviceName}"}`, { app_fortidata_name: serviceName }],
    ];
    if (stem !== serviceName) {
      cascade.push([`{app_fortidata_name="${stem}"}`, { app_fortidata_name: stem }]);
    }
    cascade.push(
      [`{job=~".*/${serviceName}"}`, { job: `~".*/${serviceName}"` }],
    );
    if (stem !== serviceName) {
      cascade.push([`{job=~".*/${stem}"}`, { job: `~".*/${stem}"` }]);
    }
    cascade.push(
      [`{container_name="${serviceName}"}`, { container_name: serviceName }],
    );

    for (const [query, selector] of cascade) {
      try {
        const result = await this.mcp.callTool("query_loki", {
          datasourceUid: this.lokiUid,
          lokiQuery: query,
          limit: 1,
        });
        const parsed = JSON.parse(result.text) as {
          data?: { result?: Array<{ values?: unknown[] }> };
        };
        const results = parsed?.data?.result ?? [];
        if (results.length > 0 && (results[0]?.values?.length ?? 0) > 0) {
          logger.debug({ serviceName, query, selector }, "Loki label resolved");
          return selector;
        }
      } catch (err) {
        logger.warn({ err, serviceName, query }, "Loki probe failed, trying next");
      }
    }

    logger.debug({ serviceName }, "No Loki labels found for service");
    return null;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/loki-resolver.test.ts`
Expected: 6 tests PASS (1 stem + 5 resolver).

**Step 5: Commit**

```bash
git add src/agent/loki-resolver.ts src/agent/loki-resolver.test.ts
git commit -m "feat: add LokiResolver module for Loki label cascade"
```

---

### Task 3: ServiceClassifier module

**Files:**
- Create: `src/agent/service-classifier.ts`
- Test: `src/agent/service-classifier.test.ts`

**Step 1: Write the failing test**

```typescript
// src/agent/service-classifier.test.ts
import { describe, it, expect } from "vitest";
import { classifyService, type ServiceContext } from "./service-classifier.js";
import type { EnvironmentContext } from "./env-context.js";

const envContext: EnvironmentContext = {
  prometheusDatasourceUid: "prom-1",
  lokiDatasourceUid: "loki-1",
  lokiLabelKeys: ["app_fortidata_name", "job"],
};

describe("classifyService", () => {
  it("returns 'full' when Loki selector is present", () => {
    const ctx = classifyService({ app_fortidata_name: "kudu" }, envContext);
    expect(ctx.classification).toBe("full");
    expect(ctx.lokiSelector).toEqual({ app_fortidata_name: "kudu" });
    expect(ctx.envContext).toBe(envContext);
  });

  it("returns 'metrics-only' when Loki selector is null", () => {
    const ctx = classifyService(null, envContext);
    expect(ctx.classification).toBe("metrics-only");
    expect(ctx.lokiSelector).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/service-classifier.test.ts`
Expected: FAIL — module doesn't exist yet.

**Step 3: Write the implementation**

```typescript
// src/agent/service-classifier.ts
import type { EnvironmentContext } from "./env-context.js";

export type ServiceContext = {
  classification: "full" | "metrics-only";
  lokiSelector: Record<string, string> | null;
  envContext: EnvironmentContext;
};

export function classifyService(
  lokiSelector: Record<string, string> | null,
  envContext: EnvironmentContext,
): ServiceContext {
  return {
    classification: lokiSelector ? "full" : "metrics-only",
    lokiSelector,
    envContext,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/service-classifier.test.ts`
Expected: 2 tests PASS.

**Step 5: Commit**

```bash
git add src/agent/service-classifier.ts src/agent/service-classifier.test.ts
git commit -m "feat: add ServiceClassifier module"
```

---

### Task 4: Update phase prompts to accept context

**Files:**
- Modify: `src/agent/rca-prompts.ts`
- Modify: `src/agent/rca-prompts.test.ts`

**Step 1: Write the failing test**

Add these tests to `src/agent/rca-prompts.test.ts`:

```typescript
// Add to existing rca-prompts.test.ts
import { buildPhasePrompt } from "./rca-prompts.js";
import type { ServiceContext } from "./service-classifier.js";

const fullContext: ServiceContext = {
  classification: "full",
  lokiSelector: { app_fortidata_name: "kudu" },
  envContext: {
    prometheusDatasourceUid: "prom-uid-1",
    lokiDatasourceUid: "loki-uid-1",
    lokiLabelKeys: ["app_fortidata_name", "job"],
  },
};

const metricsOnlyContext: ServiceContext = {
  classification: "metrics-only",
  lokiSelector: null,
  envContext: {
    prometheusDatasourceUid: "prom-uid-1",
    lokiDatasourceUid: "loki-uid-1",
    lokiLabelKeys: [],
  },
};

describe("buildPhasePrompt", () => {
  it("injects datasource UIDs into metric prompt", () => {
    const prompt = buildPhasePrompt("metrics", fullContext);
    expect(prompt).toContain("prom-uid-1");
  });

  it("injects Loki selector into log prompt", () => {
    const prompt = buildPhasePrompt("logs", fullContext);
    expect(prompt).toContain("app_fortidata_name");
    expect(prompt).toContain("kudu");
  });

  it("returns skip instruction for log phase when metrics-only", () => {
    const prompt = buildPhasePrompt("logs", metricsOnlyContext);
    expect(prompt).toContain("skip");
  });

  it("returns base prompt when no context provided", () => {
    const prompt = buildPhasePrompt("metrics");
    expect(prompt).not.toContain("datasourceUid");
    // Should still be a valid prompt
    expect(prompt.length).toBeGreaterThan(20);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/rca-prompts.test.ts`
Expected: FAIL — `buildPhasePrompt` doesn't exist yet.

**Step 3: Add `buildPhasePrompt` to `rca-prompts.ts`**

Add this function to the end of `src/agent/rca-prompts.ts` (after the existing exports, keeping them intact):

```typescript
import type { ServiceContext } from "./service-classifier.js";

type PhaseType = "metrics" | "logs" | "infra" | "synthesis";

export function buildPhasePrompt(phase: PhaseType, context?: ServiceContext): string {
  const base = {
    metrics: METRIC_DEEP_DIVE_PROMPT,
    logs: LOG_CORRELATION_PROMPT,
    infra: INFRA_HEALTH_PROMPT,
    synthesis: RCA_SYNTHESIS_PROMPT,
  }[phase];

  if (!context) return base;

  const { envContext, lokiSelector, classification } = context;

  let contextBlock = `\n\nEnvironment context (use these — do NOT call list_datasources):
- Prometheus datasourceUid: ${envContext.prometheusDatasourceUid}
- Loki datasourceUid: ${envContext.lokiDatasourceUid}`;

  if (phase === "logs") {
    if (classification === "metrics-only") {
      return `This service has no Loki logs available. Skip log analysis and respond with empty findings: {"errorPatterns": [], "stackTraces": [], "firstOccurrence": "not_available"}`;
    }
    if (lokiSelector) {
      const selectorStr = Object.entries(lokiSelector)
        .map(([k, v]) => `${k}="${v}"`)
        .join(", ");
      contextBlock += `\n- Loki label selector: {${selectorStr}} (use this — do NOT guess labels)`;
    }
  }

  if (phase === "infra" && classification === "metrics-only") {
    contextBlock += `\n- This service is metrics-only (no K8s pods). Focus on consul health and Prometheus metrics, skip pod/node checks.`;
  }

  return base + contextBlock;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/rca-prompts.test.ts`
Expected: ALL tests PASS (existing + 4 new).

**Step 5: Commit**

```bash
git add src/agent/rca-prompts.ts src/agent/rca-prompts.test.ts
git commit -m "feat: add buildPhasePrompt with optional context injection"
```

---

### Task 5: Wire Phase 0 into InvestigationAgent

**Files:**
- Modify: `src/agent/investigation.ts`
- Modify: `src/agent/investigation.test.ts`

**Step 1: Write the failing test**

Add to `src/agent/investigation.test.ts`:

```typescript
import { EnvironmentContextResolver } from "./env-context.js";
import { LokiResolver } from "./loki-resolver.js";

describe("InvestigationAgent with Phase 0", () => {
  it("passes context to phase prompts when envResolver is provided", async () => {
    const mockEnvResolver = {
      resolve: vi.fn().mockResolvedValue({
        prometheusDatasourceUid: "prom-1",
        lokiDatasourceUid: "loki-1",
        lokiLabelKeys: ["app_fortidata_name", "job"],
      }),
    } as unknown as EnvironmentContextResolver;

    const mockLokiResolver = {
      resolve: vi.fn().mockResolvedValue({ app_fortidata_name: "payments-api" }),
    };

    // LokiResolver is constructed inside investigate, so we mock it via a factory
    const llm = makeMockLlm([baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport]);
    const agent = new InvestigationAgent(llm, mockMcp, {
      maxIterations: 5,
      envResolver: mockEnvResolver,
    });

    const report = await agent.investigate(service, anomaly, "corr-ctx");

    expect(report.service).toBe("payments-api");
    expect(mockEnvResolver.resolve).toHaveBeenCalledTimes(1);
  });

  it("works without envResolver (backward compatible)", async () => {
    const llm = makeMockLlm([baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport]);
    const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

    const report = await agent.investigate(service, anomaly, "corr-noenv");

    expect(report.service).toBe("payments-api");
    expect(report.rootCause).toBe("DB connection pool exhausted");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/investigation.test.ts`
Expected: FAIL — `envResolver` option doesn't exist yet.

**Step 3: Modify `investigation.ts`**

Changes to make in `src/agent/investigation.ts`:

1. Add imports at top:
```typescript
import { EnvironmentContextResolver } from "./env-context.js";
import { LokiResolver } from "./loki-resolver.js";
import { classifyService, type ServiceContext } from "./service-classifier.js";
import { buildPhasePrompt } from "./rca-prompts.js";
```

2. Update constructor to accept optional `envResolver`:
```typescript
export class InvestigationAgent {
  private readonly llm: LlmClient;
  private readonly mcp: McpClient;
  private readonly maxIterations: number;
  private readonly envResolver?: EnvironmentContextResolver;

  constructor(llm: LlmClient, mcp: McpClient, opts: { maxIterations: number; envResolver?: EnvironmentContextResolver }) {
    this.llm = llm;
    this.mcp = mcp;
    this.maxIterations = opts.maxIterations;
    this.envResolver = opts.envResolver;
  }
```

3. Add Phase 0 at the start of `investigate()`, right after the `log` declaration (before Phase 1):
```typescript
    // Phase 0: gather context (programmatic, no LLM)
    let serviceContext: ServiceContext | undefined;
    if (this.envResolver) {
      try {
        log.debug("Running phase 0: context gathering");
        const envCtx = await this.envResolver.resolve();
        const lokiResolver = new LokiResolver(this.mcp, envCtx.lokiDatasourceUid);
        const lokiSelector = await lokiResolver.resolve(service.name);
        serviceContext = classifyService(lokiSelector, envCtx);
        log.info({ classification: serviceContext.classification, lokiSelector }, "Phase 0 complete");
      } catch (err) {
        log.warn({ err }, "Phase 0 failed, falling back to no context");
      }
    }
```

4. Update the phase calls to use `buildPhasePrompt` when context is available. Replace the three parallel phase calls with:
```typescript
    const metricPrompt = serviceContext ? buildPhasePrompt("metrics", serviceContext) : METRIC_DEEP_DIVE_PROMPT;
    const logPrompt = serviceContext ? buildPhasePrompt("logs", serviceContext) : LOG_CORRELATION_PROMPT;
    const infraPrompt = serviceContext ? buildPhasePrompt("infra", serviceContext) : INFRA_HEALTH_PROMPT;

    const [metricResult, logResult, infraResult] = await Promise.allSettled([
      this.runPhase<MetricFindings>(metricPrompt, metricMessage, METRIC_FINDINGS_SCHEMA, undefined, onTokenUsage),
      serviceContext?.classification === "metrics-only"
        ? Promise.resolve({ errorPatterns: [], stackTraces: [], firstOccurrence: "not_available" } as LogFindings)
        : this.runPhase<LogFindings>(logPrompt, logMessage, LOG_FINDINGS_SCHEMA, undefined, onTokenUsage),
      this.runPhase<InfraFindings>(infraPrompt, infraMessage, INFRA_FINDINGS_SCHEMA, undefined, onTokenUsage),
    ]);
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/investigation.test.ts`
Expected: ALL tests PASS (existing 4 + new 2).

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. No regressions.

**Step 6: Commit**

```bash
git add src/agent/investigation.ts src/agent/investigation.test.ts
git commit -m "feat: wire Phase 0 context gathering into investigation pipeline"
```

---

### Task 6: Wire EnvironmentContextResolver into app entry points

**Files:**
- Modify: `src/cli.tsx` (or wherever `InvestigationAgent` is constructed)
- Modify: `src/interfaces/slack.ts` (if it constructs `InvestigationAgent` directly)

**Step 1: Find where InvestigationAgent is constructed**

Run: `grep -rn "new InvestigationAgent" src/`

The constructor sites need to pass `envResolver: new EnvironmentContextResolver(mcp)`.

**Step 2: Update construction sites**

At each site where `InvestigationAgent` is created, add:

```typescript
import { EnvironmentContextResolver } from "./agent/env-context.js";

// Where InvestigationAgent is created:
const envResolver = new EnvironmentContextResolver(mcp);
const investigationAgent = new InvestigationAgent(llm, mcp, {
  maxIterations: config.maxIterations,
  envResolver,
});
```

**Step 3: Run full test suite and type check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: Clean compile, all tests pass.

**Step 4: Commit**

```bash
git add src/cli.tsx  # and any other modified entry points
git commit -m "feat: wire EnvironmentContextResolver into app entry points"
```

---

### Task 7: Type check and full integration verification

**Step 1: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 3: Manual smoke test (if possible)**

Run: `npm run cli` and test `investigate <service-name>` to verify Phase 0 runs before the LLM phases.

**Step 4: Final commit if any adjustments were needed**

---

## Summary

| Task | Module | New/Modified | Test |
|------|--------|-------------|------|
| 1 | EnvironmentContextResolver | New | 4 tests |
| 2 | LokiResolver | New | 6 tests |
| 3 | ServiceClassifier | New | 2 tests |
| 4 | buildPhasePrompt | Modified rca-prompts.ts | 4 tests |
| 5 | Wire Phase 0 | Modified investigation.ts | 2 tests |
| 6 | Entry points | Modified cli.tsx etc. | Type check |
| 7 | Full verification | — | Full suite |

**Revert strategy:** Delete `env-context.ts`, `loki-resolver.ts`, `service-classifier.ts` and their tests. Revert `investigation.ts` and `rca-prompts.ts`. The `envResolver` option is optional, so removing it breaks nothing.

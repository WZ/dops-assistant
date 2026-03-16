# Discover Agent Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the discover agent using Mastra with interactive CLI/GUI, MCP-provider-agnostic discovery, LLM validation, and version history.

**Architecture:** Two Mastra Agents (discovery + validation) orchestrated by a plain TypeScript module. A `ServiceRegistryStore` manages `services.yaml` with file-based version history. The CLI is an interactive Ink React app. The GUI adds services management as a Dashboard sub-section with YAML editing, discovery progress, and version history views.

**Tech Stack:** Mastra (`@mastra/core`), AI SDK, CodeMirror 6 (`@codemirror/lang-yaml`), Ink React, Vitest, Zod, YAML

**Spec:** `docs/superpowers/specs/2026-03-14-discover-agent-design.md`

---

## Chunk 1: Core Backend (Types, Registry, Agents, Workflow)

### Task 1: Types and Config

**Files:**
- Create: `src/types/discovery-types.ts`
- Modify: `src/types/agent-interfaces.ts`
- Modify: `src/config/schema.ts`
- Test: `src/types/discovery-types.test.ts`

- [ ] **Step 1: Write failing test for discovery types**

```typescript
// src/types/discovery-types.test.ts
import { describe, it, expect } from "vitest";
import { ValidatedServiceConfigSchema, ServiceRegistryVersionSchema } from "./discovery-types.js";

describe("ValidatedServiceConfig", () => {
  it("parses a verified service", () => {
    const result = ValidatedServiceConfigSchema.safeParse({
      name: "ingestion-server",
      metrics: [{ query: "up{job='ingestion'}", description: "health" }],
      logLabels: { app: "ingestion-server" },
      confidence: "verified",
      validationNotes: "metrics ✓ logs ✓",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid confidence level", () => {
    const result = ValidatedServiceConfigSchema.safeParse({
      name: "svc",
      metrics: [],
      logLabels: {},
      confidence: "unknown",
      validationNotes: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("ServiceRegistryVersion", () => {
  it("parses a version entry", () => {
    const result = ServiceRegistryVersionSchema.safeParse({
      id: "01JQ7K",
      timestamp: "2026-03-14T10:30:00Z",
      services: [{ name: "svc", metrics: [], logLabels: {} }],
      source: "discovery",
      serviceCount: 1,
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/types/discovery-types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create discovery types**

```typescript
// src/types/discovery-types.ts
import { z } from "zod";
import { type ServiceConfig } from "../config/schema.js";

export const ConfidenceSchema = z.enum(["verified", "partial", "unverified"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const ValidatedServiceConfigSchema = z.object({
  name: z.string(),
  metrics: z.array(z.object({ query: z.string(), description: z.string() })).optional().default([]),
  logLabels: z.record(z.string()).optional().default({}),
  confidence: ConfidenceSchema,
  validationNotes: z.string(),
});
export type ValidatedServiceConfig = z.infer<typeof ValidatedServiceConfigSchema>;

export const ServiceRegistryVersionSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  services: z.array(z.object({
    name: z.string(),
    metrics: z.array(z.object({ query: z.string(), description: z.string() })).optional().default([]),
    logLabels: z.record(z.string()).optional().default({}),
  })),
  source: z.enum(["discovery", "manual"]),
  serviceCount: z.number(),
});
export type ServiceRegistryVersion = z.infer<typeof ServiceRegistryVersionSchema>;
```

- [ ] **Step 4: Add IDiscoverAgent to agent-interfaces.ts**

Add to `src/types/agent-interfaces.ts` after `IInvestigationAgent`:

```typescript
import type { ValidatedServiceConfig } from "./discovery-types.js";
import type { ServiceConfig, DiscoveryConfig } from "../config/schema.js";

export interface IDiscoverAgent {
  discover(
    config: DiscoveryConfig,
    onPhase?: (phase: string) => void,
    onIteration?: OnIteration,
    onToolCall?: OnToolCallEnriched,
  ): Promise<ValidatedServiceConfig[]>;

  accept(services: ServiceConfig[], source: "discovery" | "manual"): Promise<string>;
}
```

- [ ] **Step 5: Remove consulMetric from DiscoverySchema**

In `src/config/schema.ts`, remove the `consulMetric` line from `DiscoverySchema`:

```typescript
const DiscoverySchema = z.object({
  autoRefresh: z.boolean().default(false),
  excludeServices: z.array(z.string()).default([]),
  maxIterations: z.number().default(40),
});
```

Also update any test files that reference `consulMetric` (check `src/config/schema.test.ts` and `src/server/agents.test.ts`) — remove `consulMetric` from test fixtures.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/types/discovery-types.test.ts`
Expected: PASS

- [ ] **Step 7: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/types/discovery-types.ts src/types/discovery-types.test.ts src/types/agent-interfaces.ts src/config/schema.ts
git commit -m "feat: add discovery types, IDiscoverAgent interface, remove consulMetric"
```

---

### Task 2: ServiceRegistryStore

**Files:**
- Create: `src/services/registry.ts`
- Create: `src/services/registry.test.ts`
- Modify: `src/config/loader.ts`

- [ ] **Step 1: Write failing tests for ServiceRegistryStore**

```typescript
// src/services/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ServiceRegistryStore } from "./registry.js";

describe("ServiceRegistryStore", () => {
  let dir: string;
  let store: ServiceRegistryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    store = new ServiceRegistryStore(join(dir, "services.yaml"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("load() returns empty array when file does not exist", () => {
    expect(store.load()).toEqual([]);
  });

  it("load() reads existing services.yaml", () => {
    const yaml = "- name: svc1\n  metrics: []\n  logLabels: {}\n";
    writeFileSync(join(dir, "services.yaml"), yaml);
    const result = store.load();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("svc1");
  });

  it("save() writes services.yaml and creates version snapshot", () => {
    const services = [{ name: "svc1", metrics: [], logLabels: {} }];
    const versionId = store.save(services, "discovery");
    expect(versionId).toBeTruthy();

    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("svc1");
  });

  it("listVersions() returns version history", () => {
    store.save([{ name: "a", metrics: [], logLabels: {} }], "discovery");
    store.save([{ name: "a", metrics: [], logLabels: {} }, { name: "b", metrics: [], logLabels: {} }], "manual");

    const versions = store.listVersions();
    expect(versions).toHaveLength(2);
    expect(versions[0].source).toBe("discovery");
    expect(versions[0].serviceCount).toBe(1);
    expect(versions[1].source).toBe("manual");
    expect(versions[1].serviceCount).toBe(2);
  });

  it("getVersion() returns services for a specific version", () => {
    const id = store.save([{ name: "svc1", metrics: [], logLabels: {} }], "discovery");
    const services = store.getVersion(id);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("svc1");
  });

  it("rollback() restores a previous version and creates new history entry", () => {
    const id1 = store.save([{ name: "a", metrics: [], logLabels: {} }], "discovery");
    store.save([{ name: "b", metrics: [], logLabels: {} }], "manual");

    store.rollback(id1);

    const current = store.load();
    expect(current).toHaveLength(1);
    expect(current[0].name).toBe("a");

    const versions = store.listVersions();
    expect(versions).toHaveLength(3); // original 2 + rollback entry
  });

  it("getVersion() throws for unknown id", () => {
    expect(() => store.getVersion("nonexistent")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ServiceRegistryStore**

```typescript
// src/services/registry.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { parse, stringify } from "yaml";
import { ulid } from "ulid";
import type { ServiceConfig } from "../config/schema.js";
import type { ServiceRegistryVersion } from "../types/discovery-types.js";

export class ServiceRegistryStore {
  private servicesPath: string;
  private historyDir: string;
  private indexPath: string;

  constructor(servicesPath: string) {
    this.servicesPath = servicesPath;
    this.historyDir = join(dirname(servicesPath), "services-history");
    this.indexPath = join(this.historyDir, "index.yaml");
  }

  load(): ServiceConfig[] {
    if (!existsSync(this.servicesPath)) return [];
    const raw = readFileSync(this.servicesPath, "utf-8");
    const parsed = parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ServiceConfig[];
  }

  save(services: ServiceConfig[], source: "discovery" | "manual"): string {
    // Write current services.yaml
    writeFileSync(this.servicesPath, stringify(services, { indent: 2 }));

    // Create version snapshot
    mkdirSync(this.historyDir, { recursive: true });
    const id = ulid();
    const versionFile = join(this.historyDir, `${id}-${source}.yaml`);
    writeFileSync(versionFile, stringify(services, { indent: 2 }));

    // Update index (metadata only — full data lives in version files)
    const index = this.readIndex();
    index.push({
      id,
      timestamp: new Date().toISOString(),
      source,
      serviceCount: services.length,
    });
    writeFileSync(this.indexPath, stringify(index, { indent: 2 }));

    return id;
  }

  listVersions(): Omit<ServiceRegistryVersion, "services">[] {
    return this.readIndex();
  }

  getVersion(id: string): ServiceConfig[] {
    const index = this.readIndex();
    const entry = index.find((v) => v.id === id);
    if (!entry) throw new Error(`Version not found: ${id}`);

    // Read from version file
    const files = [`${id}-discovery.yaml`, `${id}-manual.yaml`];
    for (const file of files) {
      const path = join(this.historyDir, file);
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8");
        return (parse(raw) as ServiceConfig[]) ?? [];
      }
    }

    // Fallback: return services from index entry
    return entry.services;
  }

  rollback(id: string): void {
    const services = this.getVersion(id);
    this.save(services, "manual");
  }

  private readIndex(): Omit<ServiceRegistryVersion, "services">[] {
    if (!existsSync(this.indexPath)) return [];
    const raw = readFileSync(this.indexPath, "utf-8");
    const parsed = parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as Omit<ServiceRegistryVersion, "services">[];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/registry.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Update config/loader.ts to use ServiceRegistryStore**

In `src/config/loader.ts`, replace the `loadServicesFile()` call in `loadConfig()` with `ServiceRegistryStore.load()`:

```typescript
import { ServiceRegistryStore } from "../services/registry.js";

// In loadConfig(), replace:
//   const fileServices = loadServicesFile(configPath);
// with:
  const servicesPath = getServicesFilePath(configPath);
  const registryStore = new ServiceRegistryStore(servicesPath);
  const fileServices = registryStore.load();
```

Keep `loadServicesFile()` and `getServicesFilePath()` exported for backward compatibility — they're used elsewhere.

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add src/services/registry.ts src/services/registry.test.ts src/config/loader.ts
git commit -m "feat: add ServiceRegistryStore with version history"
```

---

### Task 3: Discovery Agent

**Files:**
- Create: `src/agents/discover.ts`
- Create: `src/agents/discover.test.ts`

- [ ] **Step 1: Write failing test for discover agent creation**

```typescript
// src/agents/discover.test.ts
import { describe, it, expect } from "vitest";
import { createDiscoverAgent } from "./discover.js";
import type { LanguageModel } from "ai";

const fakeModel = {} as LanguageModel;

describe("createDiscoverAgent", () => {
  it("creates an agent with id 'discover'", () => {
    const agent = createDiscoverAgent({ model: fakeModel });
    expect(agent.id).toBe("discover");
  });

  it("creates an agent with tools when provided", () => {
    const agent = createDiscoverAgent({ model: fakeModel, tools: { fakeTool: {} as any } });
    expect(agent).toBeDefined();
  });

  it("respects maxSteps config", () => {
    const agent = createDiscoverAgent({ model: fakeModel, maxSteps: 20 });
    expect(agent).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/discover.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement discover agent**

```typescript
// src/agents/discover.ts
import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";

export interface DiscoverAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  excludeServices?: string[];
}

export function createDiscoverAgent(config: DiscoverAgentConfig) {
  const excludeList = config.excludeServices?.length
    ? `\n\nEXCLUDE these services from your results (case-insensitive): ${config.excludeServices.join(", ")}`
    : "";

  return new Agent({
    id: "discover",
    name: "discover",
    instructions: () => `You are a service discovery agent. Your job is to find all monitored services in the environment using the available tools.

## Process

1. First, explore the available tools to understand what monitoring systems are connected (metrics, logs, dashboards, etc.)
2. Use the tools to find a service catalog or registry. Common approaches:
   - Query a service health metric (e.g., consul_catalog_service_node_healthy, up, kube_pod_info)
   - List available dashboards and extract service names
   - Query label values for common service label keys
3. For each discovered service:
   - Find or construct a health/existence metric query that can verify the service is running
   - Find log label mappings — which log labels correspond to this service
4. Return ALL discovered services as a JSON array

## Output Format

Return a JSON array of service objects. Each object must have:
- "name": string — the service name
- "metrics": array of { "query": string, "description": string } — at minimum a health check query
- "logLabels": object — key-value pairs mapping log label names to values for this service (empty {} if unknown)

Example:
\`\`\`json
[
  {
    "name": "ingestion-server",
    "metrics": [{ "query": "consul_catalog_service_node_healthy{service_name=\\"ingestion-server\\"}", "description": "" }],
    "logLabels": { "app": "ingestion-server" }
  }
]
\`\`\`

Be thorough — discover ALL services, not just a sample. Return the complete list as valid JSON.${excludeList}`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 40,
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agents/discover.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/discover.ts src/agents/discover.test.ts
git commit -m "feat: add discover Mastra agent"
```

---

### Task 4: Validation Agent

**Files:**
- Create: `src/agents/discover-validator.ts`
- Create: `src/agents/discover-validator.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/agents/discover-validator.test.ts
import { describe, it, expect } from "vitest";
import { createValidatorAgent } from "./discover-validator.js";
import type { LanguageModel } from "ai";

const fakeModel = {} as LanguageModel;

describe("createValidatorAgent", () => {
  it("creates an agent with id 'discover-validator'", () => {
    const agent = createValidatorAgent({ model: fakeModel, servicesToValidate: [] });
    expect(agent.id).toBe("discover-validator");
  });

  it("includes service list in instructions", () => {
    const agent = createValidatorAgent({
      model: fakeModel,
      servicesToValidate: [{ name: "svc1", metrics: [{ query: "up{}", description: "health" }], logLabels: { app: "svc1" } }],
    });
    expect(agent).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/discover-validator.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement validation agent**

```typescript
// src/agents/discover-validator.ts
import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import type { ServiceConfig } from "../config/schema.js";

export interface ValidatorAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  servicesToValidate: ServiceConfig[];
  maxSteps?: number;
}

export function createValidatorAgent(config: ValidatorAgentConfig) {
  const serviceList = JSON.stringify(config.servicesToValidate, null, 2);

  return new Agent({
    id: "discover-validator",
    name: "discover-validator",
    instructions: () => `You are a service validation agent. You have been given a list of discovered services. Your job is to VERIFY each one by actually querying the monitoring tools.

## Services to Validate

${serviceList}

## Process

For each service:
1. Execute its metric query — does it return data?
2. If it has logLabels, query the log system using those labels — do results come back?
3. Classify the service:
   - "verified" — both metrics and logs returned data (or metrics returned data and no logLabels defined)
   - "partial" — one of metrics/logs worked but the other didn't
   - "unverified" — metrics query returned no data

## Output Format

Return a JSON array. Each entry must have ALL original fields plus:
- "confidence": "verified" | "partial" | "unverified"
- "validationNotes": a short string explaining what was checked (e.g., "metrics ✓ logs ✓" or "metrics ✗ no data returned")

Return the COMPLETE list — do not omit any services. Return valid JSON.`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps: config.maxSteps ?? 15,
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agents/discover-validator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/discover-validator.ts src/agents/discover-validator.test.ts
git commit -m "feat: add discover-validator Mastra agent"
```

---

### Task 5: Discovery Workflow

**Files:**
- Create: `src/workflows/steps/discover.ts`
- Create: `src/workflows/steps/validate.ts`
- Create: `src/workflows/discovery.ts`
- Create: `src/workflows/discovery.test.ts`

- [ ] **Step 1: Write failing test for discovery workflow**

```typescript
// src/workflows/discovery.test.ts
import { describe, it, expect, vi } from "vitest";
import { runDiscovery } from "./discovery.js";
import type { DiscoveryWorkflowConfig } from "./discovery.js";
import type { LanguageModel } from "ai";

// Mock the agent generate calls
vi.mock("@mastra/core/agent", () => ({
  Agent: class MockAgent {
    id: string;
    name: string;
    constructor(opts: any) { this.id = opts.id; this.name = opts.name; }
    async generate(prompt: string) {
      if (this.id === "discover") {
        return { text: JSON.stringify([{ name: "svc1", metrics: [{ query: "up{}", description: "" }], logLabels: {} }]) };
      }
      if (this.id === "discover-validator") {
        return { text: JSON.stringify([{ name: "svc1", metrics: [{ query: "up{}", description: "" }], logLabels: {}, confidence: "verified", validationNotes: "metrics ✓" }]) };
      }
      return { text: "[]" };
    }
  },
}));

describe("runDiscovery", () => {
  const fakeModel = {} as LanguageModel;

  it("returns validated services", async () => {
    const config: DiscoveryWorkflowConfig = {
      model: fakeModel,
      providers: [],
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
    };

    const result = await runDiscovery(config);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("svc1");
    expect(result[0].confidence).toBe("verified");
  });

  it("calls onPhase callbacks", async () => {
    const phases: string[] = [];
    const config: DiscoveryWorkflowConfig = {
      model: fakeModel,
      providers: [],
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
      onPhase: (phase) => phases.push(phase),
    };

    await runDiscovery(config);
    expect(phases).toContain("discovery");
    expect(phases).toContain("validation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflows/discovery.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement discover step**

```typescript
// src/workflows/steps/discover.ts
import { createDiscoverAgent } from "../../agents/discover.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { getAllTools } from "../../mcp/provider.js";
import { wrapToolsWithCallbacks } from "../tool-utils.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig, DiscoveryConfig } from "../../config/schema.js";
import type { OnToolCallEnriched, OnIteration } from "../../types/agent-interfaces.js";

export interface DiscoverStepConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
}

export async function runDiscoverStep(config: DiscoverStepConfig): Promise<ServiceConfig[]> {
  const rawTools = await getAllTools(config.providers).catch(() => ({}));
  const tools = config.onToolCall
    ? wrapToolsWithCallbacks(rawTools, config.onToolCall, "discovery")
    : rawTools;

  const agent = createDiscoverAgent({
    model: config.model,
    tools,
    maxSteps: config.discoveryConfig.maxIterations,
    excludeServices: config.discoveryConfig.excludeServices,
  });

  const result = await agent.generate("Discover all monitored services using the available tools. Return the complete list as JSON.");

  const parsed = safeJsonParse(result.text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed?.services && Array.isArray(parsed.services)) return parsed.services;

  return [];
}
```

- [ ] **Step 4: Implement validate step**

```typescript
// src/workflows/steps/validate.ts
import { createValidatorAgent } from "../../agents/discover-validator.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { getAllTools } from "../../mcp/provider.js";
import { wrapToolsWithCallbacks } from "../tool-utils.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../../mcp/provider.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { OnToolCallEnriched, OnIteration } from "../../types/agent-interfaces.js";

export interface ValidateStepConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  services: ServiceConfig[];
  onToolCall?: OnToolCallEnriched;
  onIteration?: OnIteration;
}

export async function runValidateStep(config: ValidateStepConfig): Promise<ValidatedServiceConfig[]> {
  const rawTools = await getAllTools(config.providers).catch(() => ({}));
  const tools = config.onToolCall
    ? wrapToolsWithCallbacks(rawTools, config.onToolCall, "validation")
    : rawTools;

  const agent = createValidatorAgent({
    model: config.model,
    tools,
    servicesToValidate: config.services,
    maxSteps: 15,
  });

  const result = await agent.generate("Validate each service by querying its metrics and log labels. Return the complete annotated list as JSON.");

  const parsed = safeJsonParse(result.text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed?.services && Array.isArray(parsed.services)) return parsed.services;

  // Fallback: return all services as unverified
  return config.services.map((s) => ({
    ...s,
    confidence: "unverified" as const,
    validationNotes: "validation agent did not return structured output",
  }));
}
```

- [ ] **Step 5: Implement discovery workflow orchestrator**

```typescript
// src/workflows/discovery.ts
import { runDiscoverStep } from "./steps/discover.js";
import { runValidateStep } from "./steps/validate.js";
import type { LanguageModel } from "ai";
import type { MastraProvider } from "../mcp/provider.js";
import type { DiscoveryConfig } from "../config/schema.js";
import type { ValidatedServiceConfig } from "../types/discovery-types.js";
import type { OnToolCallEnriched, OnIteration } from "../types/agent-interfaces.js";

export interface DiscoveryWorkflowConfig {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  onPhase?: (phase: string) => void;
  onIteration?: OnIteration;
  onToolCall?: OnToolCallEnriched;
}

export async function runDiscovery(config: DiscoveryWorkflowConfig): Promise<ValidatedServiceConfig[]> {
  // Phase 1: Discovery
  config.onPhase?.("discovery");
  const discovered = await runDiscoverStep({
    model: config.model,
    providers: config.providers,
    discoveryConfig: config.discoveryConfig,
    onToolCall: config.onToolCall,
    onIteration: config.onIteration,
  });

  if (discovered.length === 0) {
    return [];
  }

  // Phase 2: Validation
  config.onPhase?.("validation");
  const validated = await runValidateStep({
    model: config.model,
    providers: config.providers,
    services: discovered,
    onToolCall: config.onToolCall,
    onIteration: config.onIteration,
  });

  return validated;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/workflows/discovery.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/workflows/steps/discover.ts src/workflows/steps/validate.ts src/workflows/discovery.ts src/workflows/discovery.test.ts
git commit -m "feat: add discovery workflow with discover and validate steps"
```

---

### Task 6: Server Adapter

**Files:**
- Modify: `src/server/agents.ts`
- Modify: `src/server/agents.test.ts`

- [ ] **Step 1: Write failing test for MastraDiscoverAdapter**

Add to `src/server/agents.test.ts`:

```typescript
import { MastraDiscoverAdapter } from "./agents.js";

describe("MastraDiscoverAdapter", () => {
  it("exposes discover() and accept() methods", () => {
    const adapter = new MastraDiscoverAdapter({
      model: {} as any,
      providers: [],
      discoveryConfig: { autoRefresh: false, excludeServices: [], maxIterations: 5 },
      registryStore: { load: () => [], save: () => "id", listVersions: () => [], getVersion: () => [], rollback: () => {} } as any,
    });
    expect(typeof adapter.discover).toBe("function");
    expect(typeof adapter.accept).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/agents.test.ts`
Expected: FAIL — MastraDiscoverAdapter not found

- [ ] **Step 3: Implement MastraDiscoverAdapter**

Add to `src/server/agents.ts`:

```typescript
import { runDiscovery } from "../workflows/discovery.js";
import type { DiscoveryWorkflowConfig } from "../workflows/discovery.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { IDiscoverAgent, OnToolCallEnriched, OnIteration } from "../types/agent-interfaces.js";
import type { ValidatedServiceConfig } from "../types/discovery-types.js";
import type { ServiceConfig, DiscoveryConfig } from "../config/schema.js";

export interface MastraDiscoverAdapterDeps {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  registryStore: ServiceRegistryStore;
}

export class MastraDiscoverAdapter implements IDiscoverAgent {
  private deps: MastraDiscoverAdapterDeps;

  constructor(deps: MastraDiscoverAdapterDeps) {
    this.deps = deps;
  }

  async discover(
    config: DiscoveryConfig,
    onPhase?: (phase: string) => void,
    onIteration?: OnIteration,
    onToolCall?: OnToolCallEnriched,
  ): Promise<ValidatedServiceConfig[]> {
    return runDiscovery({
      model: this.deps.model,
      providers: this.deps.providers,
      discoveryConfig: config,
      onPhase,
      onIteration,
      onToolCall,
    });
  }

  async accept(services: ServiceConfig[], source: "discovery" | "manual"): Promise<string> {
    return this.deps.registryStore.save(services, source);
  }
}
```

- [ ] **Step 4: Update createMastraAdapters to include discover adapter**

In `src/server/agents.ts`, update `createMastraAdapters()`:

```typescript
export async function createMastraAdapters(deps: MastraAdapterDeps) {
  // ... existing chat + investigation adapter code ...

  // Add discover adapter
  const registryStore = deps.registryStore;
  const discoverAgent = registryStore
    ? new MastraDiscoverAdapter({
        model,
        providers,
        discoveryConfig: config.discovery,
        registryStore,
      })
    : undefined;

  return { chatAgent, investigationAgent, discoverAgent };
}
```

Update `MastraAdapterDeps` to include optional `registryStore`:

```typescript
export interface MastraAdapterDeps {
  config: Config;
  providers: MastraProvider[];
  noHistory?: boolean;
  registryStore?: ServiceRegistryStore;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/server/agents.test.ts`
Expected: PASS

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/server/agents.ts src/server/agents.test.ts
git commit -m "feat: add MastraDiscoverAdapter to server agents"
```

---

## Chunk 2: Server Integration, CLI, WebSocket

### Task 7: Server Routes for Services CRUD

**Files:**
- Modify: `src/server/routes.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add services REST endpoints to routes.ts**

Add after existing `app.get("/api/services", ...)` in `registerRoutes()`:

```typescript
// Add registryStore to registerRoutes params:
export function registerRoutes(
  app: Express, db: Database, services: ServiceConfig[], mcp: IMcpClient,
  skillStore?: SkillStore, registryStore?: ServiceRegistryStore,
): void {
  // Existing GET /api/services stays as-is

  if (registryStore) {
    app.put("/api/services", (req: Request, res: Response) => {
      try {
        const services = req.body as ServiceConfig[];
        if (!Array.isArray(services)) {
          res.status(400).json({ error: "Body must be an array of services" });
          return;
        }
        const versionId = registryStore.save(services, "manual");
        res.json({ versionId, serviceCount: services.length });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/services/versions", (_req: Request, res: Response) => {
      res.json(registryStore.listVersions());
    });

    app.get("/api/services/versions/:id", (req: Request, res: Response) => {
      try {
        const services = registryStore.getVersion(req.params["id"]!);
        res.json(services);
      } catch (err) {
        res.status(404).json({ error: String(err) });
      }
    });

    app.post("/api/services/versions/:id/restore", (req: Request, res: Response) => {
      try {
        registryStore.rollback(req.params["id"]!);
        res.json({ restored: true, services: registryStore.load() });
      } catch (err) {
        res.status(404).json({ error: String(err) });
      }
    });
  }
}
```

- [ ] **Step 2: Update server/index.ts to create and pass registryStore**

In `src/server/index.ts`, add after config loading:

```typescript
import { ServiceRegistryStore } from "../services/registry.js";
import { getServicesFilePath } from "../config/loader.js";

// After loadConfig():
const servicesPath = getServicesFilePath(process.env["CONFIG_PATH"] ?? "config.yaml");
const registryStore = new ServiceRegistryStore(servicesPath);

// Update registerRoutes call:
registerRoutes(app, db, config.services, createStubMcpClient(), skillStore, registryStore);

// Update createMastraAdapters call:
const mastraAdapters = await createMastraAdapters({ config, providers, registryStore });
const { chatAgent: agent, investigationAgent, discoverAgent } = mastraAdapters;
```

- [ ] **Step 3: Type check and run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: No type errors, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/server/routes.ts src/server/index.ts
git commit -m "feat: add services CRUD REST endpoints and registryStore wiring"
```

---

### Task 8: WebSocket Messages for Discovery

**Files:**
- Modify: `src/types/ws-types.ts`
- Modify: `src/server/ws-handler.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add discover message types to ws-types.ts**

In `src/types/ws-types.ts`, extend `ClientMessage` and `ServerMessage`:

```typescript
export type ClientMessage =
  | { type: "chat"; message: string }
  | { type: "deep_investigate"; investigationId: string; message: string }
  | { type: "new_session" }
  | { type: "discover" }
  | { type: "discover:accept"; services: ServiceConfig[] }
  | { type: "discover:reject" };

export type ServerMessage =
  // ... existing messages ...
  | { type: "discover:phase"; phase: string; status: "running" | "complete" }
  | { type: "discover:iteration"; phase: string; iteration: number; maxIterations: number; description: string }
  | { type: "discover:tool_call"; phase: string; tool: string; args: Record<string, unknown>; status: "calling" | "success" | "error"; result?: string; durationMs?: number }
  | { type: "discover:complete"; services: ValidatedServiceConfig[] }
  | { type: "discover:error"; message: string }
  | { type: "discover:pending"; services: ValidatedServiceConfig[] }
  | { type: "discover:resolved" };
```

Add imports at top:

```typescript
import type { ServiceConfig } from "../config/schema.js";
import type { ValidatedServiceConfig } from "./discovery-types.js";
```

- [ ] **Step 2: Add discover handling to ws-handler.ts**

Add `discoverAgent`, `discoveryConfig`, and pending state to `WsDeps`:

```typescript
export interface WsDeps {
  // ... existing fields ...
  discoverAgent?: IDiscoverAgent;
  discoveryConfig?: DiscoveryConfig;
  getPendingDiscovery?: () => ValidatedServiceConfig[] | null;
  clearPendingDiscovery?: () => void;
}
```

Add discovery message handling in `handleClientMessage()`:

```typescript
if (msg.type === "discover" && deps.discoverAgent) {
  try {
    const services = await deps.discoverAgent.discover(
      deps.discoveryConfig ?? { autoRefresh: false, excludeServices: [], maxIterations: 40 },
      (phase) => send({ type: "discover:phase", phase, status: "running" }),
      (phase, iteration, maxIterations, description) =>
        send({ type: "discover:iteration", phase, iteration, maxIterations, description }),
      (name, args, result, durationMs, error, phase) =>
        send({
          type: "discover:tool_call",
          phase: phase ?? "discovery",
          tool: name,
          args,
          status: error ? "error" : result ? "success" : "calling",
          result,
          durationMs,
        }),
    );
    send({ type: "discover:phase", phase: "validation", status: "complete" });
    send({ type: "discover:complete", services });
  } catch (err) {
    send({ type: "discover:error", message: err instanceof Error ? err.message : String(err) });
  }
  return;
}

if (msg.type === "discover:accept" && deps.discoverAgent) {
  await deps.discoverAgent.accept(msg.services, "discovery");
  deps.clearPendingDiscovery?.();
  // Notify other clients
  broadcastToOthers(ws, wss, { type: "discover:resolved" });
  return;
}

if (msg.type === "discover:reject") {
  deps.clearPendingDiscovery?.();
  broadcastToOthers(ws, wss, { type: "discover:resolved" });
  return;
}
```

- [ ] **Step 3: Pass discoverAgent to setupWebSocket in server/index.ts**

Update the `setupWebSocket` call:

```typescript
setupWebSocket(server, {
  db, agent, investigationAgent, router, memory,
  services: config.services, skillStore, validateLlmServiceMatch, matchServiceFromText,
  discoverAgent,
  discoveryConfig: config.discovery,
});
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/types/ws-types.ts src/server/ws-handler.ts src/server/index.ts
git commit -m "feat: add discovery WebSocket message handling"
```

---

### Task 9: Auto-Refresh at Startup

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add auto-refresh logic after adapter creation**

In `src/server/index.ts`, after `createMastraAdapters()` and before `server.listen()`:

```typescript
// Auto-refresh: run discovery in background if configured
let pendingDiscovery: ValidatedServiceConfig[] | null = null;

if (config.discovery.autoRefresh && discoverAgent) {
  logger.info("Auto-refresh enabled, running background discovery...");
  discoverAgent
    .discover(config.discovery)
    .then((services) => {
      pendingDiscovery = services;
      logger.info({ count: services.length }, "Auto-refresh discovery complete, pending review");
    })
    .catch((err) => {
      logger.warn({ err }, "Auto-refresh discovery failed");
    });
}
```

- [ ] **Step 2: Pass pending state to WebSocket deps via getter/setter**

Use getter/setter functions to bridge the mutable `pendingDiscovery` variable to `WsDeps`:

```typescript
// In setupWebSocket call:
setupWebSocket(server, {
  db, agent, investigationAgent, router, memory,
  services: config.services, skillStore, validateLlmServiceMatch, matchServiceFromText,
  discoverAgent,
  discoveryConfig: config.discovery,
  getPendingDiscovery: () => pendingDiscovery,
  clearPendingDiscovery: () => { pendingDiscovery = null; },
});
```

In `ws-handler.ts`, inside `wss.on("connection", ...)`, after connection is established:

```typescript
const pending = deps.getPendingDiscovery?.();
if (pending) {
  send({ type: "discover:pending", services: pending });
}
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts src/server/ws-handler.ts
git commit -m "feat: add auto-refresh discovery at server startup"
```

---

### Task 10: CLI Discover Command

**Files:**
- Create: `src/cli/commands/discover.tsx`
- Create: `src/cli/commands/discover.test.ts`
- Modify: `src/cli/index.tsx`
- Modify: `package.json`

- [ ] **Step 1: Write failing test for CLI discover command**

```typescript
// src/cli/commands/discover.test.ts
import { describe, it, expect, vi } from "vitest";
import type { IDiscoverAgent } from "../../types/agent-interfaces.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";

describe("discover CLI", () => {
  it("module exports runDiscover function", async () => {
    const mod = await import("./discover.js");
    expect(typeof mod.runDiscover).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/discover.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement CLI discover command**

```tsx
// src/cli/commands/discover.tsx
import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify, parse } from "yaml";
import type { IDiscoverAgent } from "../../types/agent-interfaces.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { ServiceConfig, DiscoveryConfig } from "../../config/schema.js";

type Phase = "running" | "review" | "editing" | "done";

interface DiscoverAppProps {
  agent: IDiscoverAgent;
  config: DiscoveryConfig;
}

function DiscoverApp({ agent, config }: DiscoverAppProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>("running");
  const [currentPhase, setCurrentPhase] = useState<string>("discovery");
  const [iteration, setIteration] = useState({ current: 0, max: 0, label: "" });
  const [toolCalls, setToolCalls] = useState<string[]>([]);
  const [services, setServices] = useState<ValidatedServiceConfig[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agent
      .discover(
        config,
        (p) => setCurrentPhase(p),
        (_phase, current, max, label) => setIteration({ current, max, label }),
        (name, args) => {
          const argsStr = JSON.stringify(args).slice(0, 80);
          setToolCalls((prev) => [...prev.slice(-20), `→ ${name}(${argsStr})`]);
        },
      )
      .then((result) => {
        setServices(result);
        setPhase("review");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("done");
      });
  }, []);

  useInput((input, key) => {
    if (phase !== "review") return;

    if (input === "a") {
      // Accept
      agent.accept(
        services.map(({ confidence: _c, validationNotes: _v, ...s }) => s),
        "discovery",
      ).then(() => {
        setPhase("done");
        setTimeout(() => exit(), 100);
      });
    }

    if (input === "r") {
      setPhase("done");
      setTimeout(() => exit(), 100);
    }

    if (input === "f") {
      setServices((prev) => prev.filter((s) => s.confidence !== "unverified"));
    }

    if (input === "e") {
      setPhase("editing");
      const tmpFile = join(tmpdir(), `dops-discover-${Date.now()}.yaml`);
      const stripped = services.map(({ confidence: _c, validationNotes: _v, ...s }) => s);
      writeFileSync(tmpFile, stringify(stripped, { indent: 2 }));

      const editor = process.env["EDITOR"] || "vi";
      spawnSync(editor, [tmpFile], { stdio: "inherit" });

      try {
        const edited = readFileSync(tmpFile, "utf-8");
        const parsed = parse(edited) as ServiceConfig[];
        if (Array.isArray(parsed)) {
          setServices(parsed.map((s) => ({ ...s, confidence: "unverified" as const, validationNotes: "edited by user" })));
        }
      } catch { /* ignore parse errors */ }

      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      setPhase("review");
    }
  });

  if (phase === "running") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="magenta">▸ Phase: {currentPhase}</Text>
        {iteration.max > 0 && (
          <Text color="gray">  ⠋ {iteration.label} ({iteration.current}/{iteration.max})</Text>
        )}
        {toolCalls.slice(-5).map((tc, i) => (
          <Text key={i} color="gray" dimColor>  {tc}</Text>
        ))}
      </Box>
    );
  }

  if (phase === "review") {
    const verified = services.filter((s) => s.confidence === "verified").length;
    const partial = services.filter((s) => s.confidence === "partial").length;
    const unverified = services.filter((s) => s.confidence === "unverified").length;

    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="yellow">▸ Review Results</Text>
        <Box gap={2}>
          <Text color="green">■ verified ({verified})</Text>
          <Text color="yellow">■ partial ({partial})</Text>
          <Text color="red">■ unverified ({unverified})</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {services.slice(0, 10).map((s) => (
            <Text key={s.name} color={s.confidence === "verified" ? "green" : s.confidence === "partial" ? "yellow" : "red"}>
              {"  "}{s.name.padEnd(30)} {s.confidence.padEnd(12)} {s.validationNotes}
            </Text>
          ))}
          {services.length > 10 && <Text color="gray">  ... ({services.length - 10} more)</Text>}
        </Box>
        <Box marginTop={1}>
          <Text color="magenta">  [a] Accept all  [e] Edit in $EDITOR  [r] Reject  [f] Filter unverified</Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  return <Text color="green">Done.</Text>;
}

export async function runDiscover(agent: IDiscoverAgent, config: DiscoveryConfig): Promise<void> {
  const { waitUntilExit } = render(<DiscoverApp agent={agent} config={config} />);
  await waitUntilExit();
}
```

- [ ] **Step 4: Add discover command to CLI dispatcher**

In `src/cli/index.tsx`, add the discover command dispatch:

```typescript
if (parsed.command === "discover") {
  const { createMastraAdapters } = await import("../server/agents.js");
  const { ServiceRegistryStore } = await import("../services/registry.js");
  const { getServicesFilePath } = await import("../config/loader.js");
  const { runDiscover } = await import("./commands/discover.js");

  const servicesPath = getServicesFilePath(parsed.flags.config);
  const registryStore = new ServiceRegistryStore(servicesPath);
  const { discoverAgent } = await createMastraAdapters({ config, providers, registryStore });

  if (!discoverAgent) {
    return writeOutput({ command: "discover", status: "error", error: "No MCP providers configured" }, 1);
  }

  return runDiscover(discoverAgent, config.discovery);
}
```

- [ ] **Step 5: Add npm script to package.json**

Add to `"scripts"` in `package.json`:

```json
"cli:discover": "NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 tsx src/cli/index.tsx discover",
"discover": "NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 tsx src/cli/index.tsx discover"
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/cli/commands/discover.test.ts`
Expected: PASS

- [ ] **Step 7: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/discover.tsx src/cli/commands/discover.test.ts src/cli/index.tsx package.json
git commit -m "feat: add interactive CLI discover command"
```

---

## Chunk 3: GUI Components

### Task 11: Install CodeMirror Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install CodeMirror 6 packages**

Run: `npm install @codemirror/lang-yaml @codemirror/view @codemirror/state codemirror @codemirror/theme-one-dark`

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add CodeMirror 6 for YAML editor"
```

---

### Task 12: YamlEditor Component

**Files:**
- Create: `src/web/components/YamlEditor.tsx`

- [ ] **Step 1: Create YamlEditor component**

```tsx
// src/web/components/YamlEditor.tsx
import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { yaml } from "@codemirror/lang-yaml";
import { oneDark } from "@codemirror/theme-one-dark";

interface YamlEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}

export function YamlEditor({ value, onChange, readOnly }: YamlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        yaml(),
        oneDark,
        EditorView.lineWrapping,
        ...(readOnly ? [EditorState.readOnly.of(true)] : []),
        ...(onChange
          ? [EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                onChange(update.state.doc.toString());
              }
            })]
          : []),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
    };
  }, [readOnly]);

  // Update content when value prop changes externally
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="border border-border rounded-md overflow-hidden [&_.cm-editor]:!bg-transparent [&_.cm-gutters]:!bg-card/30"
    />
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/components/YamlEditor.tsx
git commit -m "feat: add YamlEditor component with CodeMirror 6"
```

---

### Task 13: FirstRunBanner Component

**Files:**
- Create: `src/web/components/FirstRunBanner.tsx`

- [ ] **Step 1: Create FirstRunBanner**

```tsx
// src/web/components/FirstRunBanner.tsx
interface FirstRunBannerProps {
  onRunDiscovery: () => void;
  onDismiss: () => void;
}

export function FirstRunBanner({ onRunDiscovery, onDismiss }: FirstRunBannerProps) {
  return (
    <div className="mx-6 mt-4 p-4 rounded-lg border bg-card/40 flex items-center gap-4">
      <div className="text-2xl bg-primary/10 text-primary p-2 rounded-md">📡</div>
      <div className="flex-1">
        <p className="font-semibold text-sm">No services configured</p>
        <p className="text-xs text-muted-foreground/60">
          Run service discovery to detect your monitored services, or add them manually.
        </p>
      </div>
      <button
        onClick={onRunDiscovery}
        className="px-4 py-2 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
      >
        Run Discovery
      </button>
      <button
        onClick={onDismiss}
        className="px-4 py-2 text-xs font-medium rounded-md border border-border text-muted-foreground hover:bg-accent"
      >
        Dismiss
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/components/FirstRunBanner.tsx
git commit -m "feat: add FirstRunBanner component"
```

---

### Task 14: ServicesSection Component

**Files:**
- Create: `src/web/components/ServicesSection.tsx`

- [ ] **Step 1: Create ServicesSection (dashboard card)**

```tsx
// src/web/components/ServicesSection.tsx
import type { ServiceConfig } from "../../config/schema.js";

interface ServicesSectionProps {
  services: ServiceConfig[];
  onManage: () => void;
  onRediscover: () => void;
}

export function ServicesSection({ services, onManage, onRediscover }: ServicesSectionProps) {
  if (services.length === 0) return null;

  return (
    <section className="mt-8">
      <div className="rounded-lg border bg-card/40 overflow-hidden">
        <div className="flex items-center px-4 py-3 border-b">
          <span className="font-semibold text-sm flex-1">Services</span>
          <span className="text-xs text-muted-foreground/50 mr-3">
            {services.length} service(s)
          </span>
          <button
            onClick={onManage}
            className="text-xs text-primary border border-border px-3 py-1 rounded hover:bg-accent mr-2"
          >
            Manage
          </button>
          <button
            onClick={onRediscover}
            className="text-xs text-muted-foreground border border-border px-3 py-1 rounded hover:bg-accent"
          >
            Re-discover
          </button>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/components/ServicesSection.tsx
git commit -m "feat: add ServicesSection dashboard card"
```

---

### Task 15: DiscoveryProgress Component

**Files:**
- Create: `src/web/components/DiscoveryProgress.tsx`

- [ ] **Step 1: Create DiscoveryProgress**

```tsx
// src/web/components/DiscoveryProgress.tsx
interface ToolCallEntry {
  timestamp: string;
  tool: string;
  status: "calling" | "success" | "error";
  args?: Record<string, unknown>;
}

interface DiscoveryProgressProps {
  phase: string;
  phaseStatus: "running" | "complete";
  iteration?: { current: number; max: number; description: string };
  toolCalls: ToolCallEntry[];
  onBack: () => void;
}

export function DiscoveryProgress({ phase, phaseStatus, iteration, toolCalls, onBack }: DiscoveryProgressProps) {
  const phases = ["discovery", "validation", "review"];
  const currentIdx = phases.indexOf(phase);

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Breadcrumb */}
      <div className="text-xs text-muted-foreground/50 mb-4">
        <button onClick={onBack} className="text-primary hover:underline">Dashboard</button>
        <span className="mx-1.5">›</span>
        <span>Services</span>
        <span className="mx-1.5">›</span>
        <span>Discovery</span>
      </div>

      {/* Phase stepper */}
      <div className="flex items-center gap-3 mb-6">
        {phases.map((p, i) => (
          <div key={p} className="flex items-center gap-2">
            {i > 0 && <div className={`w-8 h-px ${i <= currentIdx ? "bg-primary" : "bg-border"}`} />}
            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
              i < currentIdx ? "bg-green-500 text-black" :
              i === currentIdx ? "bg-primary text-primary-foreground" :
              "bg-muted text-muted-foreground"
            }`}>
              {i < currentIdx ? "✓" : i + 1}
            </div>
            <span className={`text-xs ${i <= currentIdx ? "text-foreground" : "text-muted-foreground/50"}`}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </span>
          </div>
        ))}
      </div>

      {/* Progress */}
      <div className="rounded-lg border bg-card/40 p-4">
        {iteration && iteration.max > 0 && (
          <>
            <div className="flex items-center gap-2 mb-2 text-sm">
              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span>{iteration.description} ({iteration.current}/{iteration.max})</span>
            </div>
            <div className="h-1 bg-muted rounded mb-4">
              <div
                className="h-1 bg-primary rounded transition-all"
                style={{ width: `${(iteration.current / iteration.max) * 100}%` }}
              />
            </div>
          </>
        )}

        {/* Tool call log */}
        <div className="font-mono text-[11px] text-muted-foreground/60 max-h-40 overflow-y-auto space-y-0.5">
          {toolCalls.slice(-20).map((tc, i) => (
            <div key={i}>
              <span className="text-muted-foreground/30">{tc.timestamp}</span>{" "}
              <span className={tc.status === "error" ? "text-red-400" : tc.status === "success" ? "text-green-400" : "text-primary"}>
                {tc.status === "success" ? "✓" : tc.status === "error" ? "✗" : "→"}
              </span>{" "}
              {tc.tool}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/components/DiscoveryProgress.tsx
git commit -m "feat: add DiscoveryProgress component"
```

---

### Task 16: DiscoveryReview Component

**Files:**
- Create: `src/web/components/DiscoveryReview.tsx`

- [ ] **Step 1: Create DiscoveryReview**

```tsx
// src/web/components/DiscoveryReview.tsx
import { useState } from "react";
import { stringify, parse } from "yaml";
import { YamlEditor } from "./YamlEditor.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { ServiceConfig } from "../../config/schema.js";

interface DiscoveryReviewProps {
  services: ValidatedServiceConfig[];
  onAccept: (services: ServiceConfig[]) => void;
  onReject: () => void;
  onBack: () => void;
}

export function DiscoveryReview({ services: initialServices, onAccept, onReject, onBack }: DiscoveryReviewProps) {
  const [services, setServices] = useState(initialServices);
  const [showEditor, setShowEditor] = useState(false);
  const [yamlValue, setYamlValue] = useState(() => {
    const stripped = initialServices.map(({ confidence: _c, validationNotes: _v, ...s }) => s);
    return stringify(stripped, { indent: 2 });
  });

  const verified = services.filter((s) => s.confidence === "verified").length;
  const partial = services.filter((s) => s.confidence === "partial").length;
  const unverified = services.filter((s) => s.confidence === "unverified").length;

  const handleFilter = () => {
    const filtered = services.filter((s) => s.confidence !== "unverified");
    setServices(filtered);
    const stripped = filtered.map(({ confidence: _c, validationNotes: _v, ...s }) => s);
    setYamlValue(stringify(stripped, { indent: 2 }));
  };

  const handleAccept = () => {
    try {
      const parsed = parse(yamlValue);
      if (Array.isArray(parsed)) {
        onAccept(parsed);
        return;
      }
    } catch { /* fall through */ }
    onAccept(services.map(({ confidence: _c, validationNotes: _v, ...s }) => s));
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Breadcrumb */}
      <div className="text-xs text-muted-foreground/50 mb-4">
        <button onClick={onBack} className="text-primary hover:underline">Dashboard</button>
        <span className="mx-1.5">›</span>
        <span>Services</span>
        <span className="mx-1.5">›</span>
        <span>Review</span>
      </div>

      {/* Summary card */}
      <div className="rounded-lg border bg-card/40 p-4 mb-4">
        <h3 className="font-semibold text-sm mb-3">Discovery Complete</h3>
        <div className="flex gap-6 text-center">
          <div>
            <div className="text-2xl font-bold">{services.length}</div>
            <div className="text-[10px] text-muted-foreground/50">services found</div>
          </div>
          <div className="w-px bg-border" />
          <div>
            <div className="text-2xl font-bold text-green-400">{verified}</div>
            <div className="text-[10px] text-muted-foreground/50">verified</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-yellow-400">{partial}</div>
            <div className="text-[10px] text-muted-foreground/50">partial</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-red-400">{unverified}</div>
            <div className="text-[10px] text-muted-foreground/50">unverified</div>
          </div>
        </div>

        {/* Service name list */}
        <div className="mt-3 bg-background/50 rounded p-2 max-h-20 overflow-y-auto font-mono text-[11px]">
          {services.map((s) => (
            <span
              key={s.name}
              className={`inline mr-1.5 ${
                s.confidence === "verified" ? "text-green-400" :
                s.confidence === "partial" ? "text-yellow-400" : "text-red-400"
              }`}
            >
              {s.name}
            </span>
          ))}
        </div>
      </div>

      {/* Expandable YAML editor */}
      <div className="rounded-lg border bg-card/40 overflow-hidden mb-4">
        <button
          onClick={() => setShowEditor(!showEditor)}
          className="flex items-center w-full px-4 py-2.5 text-left border-b hover:bg-accent/50"
        >
          <span className="text-primary mr-2">{showEditor ? "▾" : "▸"}</span>
          <span className="text-sm flex-1">Edit YAML</span>
          <span className="text-[10px] text-muted-foreground/40">Click to expand and edit before accepting</span>
        </button>
        {showEditor && (
          <div className="max-h-80 overflow-y-auto">
            <YamlEditor value={yamlValue} onChange={setYamlValue} />
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleAccept}
          className="px-5 py-2 text-sm font-semibold rounded-md bg-green-500 text-black hover:bg-green-400"
        >
          Accept
        </button>
        <button
          onClick={onReject}
          className="px-5 py-2 text-sm rounded-md border border-border text-red-400 hover:bg-accent"
        >
          Reject
        </button>
        <button
          onClick={handleFilter}
          className="px-5 py-2 text-sm rounded-md border border-border text-muted-foreground hover:bg-accent"
        >
          Filter Unverified
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/components/DiscoveryReview.tsx
git commit -m "feat: add DiscoveryReview component"
```

---

### Task 17: ServicesManage Component

**Files:**
- Create: `src/web/components/ServicesManage.tsx`

- [ ] **Step 1: Create ServicesManage (YAML editor view)**

```tsx
// src/web/components/ServicesManage.tsx
import { useState, useEffect } from "react";
import { stringify } from "yaml";
import { YamlEditor } from "./YamlEditor.js";
import type { ServiceConfig } from "../../config/schema.js";

interface ServicesManageProps {
  onRunDiscovery: () => void;
  onViewHistory: () => void;
  onBack: () => void;
}

export function ServicesManage({ onRunDiscovery, onViewHistory, onBack }: ServicesManageProps) {
  const [services, setServices] = useState<ServiceConfig[]>([]);
  const [yamlValue, setYamlValue] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/services")
      .then((r) => r.json())
      .then((data: ServiceConfig[]) => {
        setServices(data);
        setYamlValue(stringify(data, { indent: 2 }));
      })
      .catch(() => {});
  }, []);

  const handleChange = (value: string) => {
    setYamlValue(value);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { parse } = await import("yaml");
      const parsed = parse(yamlValue);
      if (!Array.isArray(parsed)) throw new Error("Must be an array");

      const res = await fetch("/api/services", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });

      if (res.ok) {
        setDirty(false);
        setServices(parsed);
      }
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setYamlValue(stringify(services, { indent: 2 }));
    setDirty(false);
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Breadcrumb */}
      <div className="text-xs text-muted-foreground/50 mb-4">
        <button onClick={onBack} className="text-primary hover:underline">Dashboard</button>
        <span className="mx-1.5">›</span>
        <span>Services</span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={onRunDiscovery}
          className="px-3 py-1.5 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Run Discovery
        </button>
        <button
          onClick={onViewHistory}
          className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-accent"
        >
          Version History
        </button>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground/50">{services.length} services</span>
      </div>

      {/* YAML editor */}
      <div className="rounded-lg border bg-card/40 overflow-hidden">
        <div className="flex items-center px-3 py-2 border-b bg-card/30 text-[11px]">
          <span className="text-muted-foreground/50 flex-1">services.yaml</span>
          {dirty && (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-2.5 py-1 rounded bg-green-500 text-black text-[11px] mr-1.5 hover:bg-green-400 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={handleDiscard}
                className="px-2.5 py-1 rounded border border-border text-muted-foreground text-[11px] hover:bg-accent"
              >
                Discard
              </button>
            </>
          )}
        </div>
        <YamlEditor value={yamlValue} onChange={handleChange} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/components/ServicesManage.tsx
git commit -m "feat: add ServicesManage component with YAML editor"
```

---

### Task 18: VersionHistory Component

**Files:**
- Create: `src/web/components/VersionHistory.tsx`

- [ ] **Step 1: Create VersionHistory**

```tsx
// src/web/components/VersionHistory.tsx
import { useState, useEffect } from "react";
import type { ServiceRegistryVersion } from "../../types/discovery-types.js";

interface VersionHistoryProps {
  onBack: () => void;
}

export function VersionHistory({ onBack }: VersionHistoryProps) {
  const [versions, setVersions] = useState<ServiceRegistryVersion[]>([]);

  useEffect(() => {
    fetch("/api/services/versions")
      .then((r) => r.json())
      .then(setVersions)
      .catch(() => {});
  }, []);

  const handleRestore = async (id: string) => {
    const res = await fetch(`/api/services/versions/${id}/restore`, { method: "POST" });
    if (res.ok) {
      // Refresh versions list
      const updated = await fetch("/api/services/versions").then((r) => r.json());
      setVersions(updated);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Breadcrumb */}
      <div className="text-xs text-muted-foreground/50 mb-4">
        <span className="text-muted-foreground/40">Dashboard</span>
        <span className="mx-1.5">›</span>
        <button onClick={onBack} className="text-primary hover:underline">Services</button>
        <span className="mx-1.5">›</span>
        <span>History</span>
      </div>

      <h2 className="font-semibold text-sm mb-4">Version History</h2>

      <div className="space-y-2">
        {versions.length === 0 && (
          <p className="text-sm text-muted-foreground/40">No version history yet</p>
        )}
        {versions.map((v, i) => (
          <div key={v.id} className="rounded-lg border bg-card/40 overflow-hidden">
            <div className="flex items-center px-4 py-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">v{versions.length - i}</span>
                  {i === versions.length - 1 && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-primary/10 text-primary">current</span>
                  )}
                  <span className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground">{v.source}</span>
                </div>
                <div className="text-[11px] text-muted-foreground/40 mt-1">
                  {new Date(v.timestamp).toLocaleString()} · {v.serviceCount} services
                </div>
              </div>
              {i < versions.length - 1 && (
                <button
                  onClick={() => handleRestore(v.id)}
                  className="text-[11px] px-2.5 py-1 rounded border border-border text-yellow-400 hover:bg-accent"
                >
                  Restore
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/components/VersionHistory.tsx
git commit -m "feat: add VersionHistory component"
```

---

### Task 19: Wire GUI into Dashboard and App

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/components/Dashboard.tsx`

- [ ] **Step 1: Extend LeftPaneView type in App.tsx**

Update `LeftPaneView` in `src/web/App.tsx`:

```typescript
export type LeftPaneView =
  | { type: "dashboard" }
  | { type: "investigation"; id: string }
  | { type: "skills" }
  | { type: "services:manage" }
  | { type: "services:history" }
  | { type: "services:discovery" }
  | { type: "services:review" };
```

- [ ] **Step 2: Add discovery state management in App.tsx**

Add state and WebSocket message handling for discovery (must come before the rendering code that uses it):

```typescript
const [discoveryState, setDiscoveryState] = useState({
  phase: "discovery",
  status: "running" as "running" | "complete",
  iteration: { current: 0, max: 0, description: "" },
  toolCalls: [] as Array<{ timestamp: string; tool: string; status: string; args?: Record<string, unknown> }>,
  results: [] as ValidatedServiceConfig[],
});

// In useEffect handling ws.messages:
useEffect(() => {
  const last = ws.messages[ws.messages.length - 1];
  if (!last) return;

  if (last.type === "discover:phase") {
    setDiscoveryState((prev) => ({ ...prev, phase: last.phase, status: last.status }));
  } else if (last.type === "discover:iteration") {
    setDiscoveryState((prev) => ({
      ...prev,
      iteration: { current: last.iteration, max: last.maxIterations, description: last.description },
    }));
  } else if (last.type === "discover:tool_call") {
    setDiscoveryState((prev) => ({
      ...prev,
      toolCalls: [...prev.toolCalls.slice(-50), {
        timestamp: new Date().toLocaleTimeString(),
        tool: last.tool,
        status: last.status,
        args: last.args,
      }],
    }));
  } else if (last.type === "discover:complete") {
    setDiscoveryState((prev) => ({ ...prev, results: last.services }));
    setLeftPane({ type: "services:review" });
  } else if (last.type === "discover:pending") {
    setDiscoveryState((prev) => ({ ...prev, results: last.services }));
    setLeftPane({ type: "services:review" });
  }
}, [ws.messages]);
```

- [ ] **Step 3: Add services view rendering in App.tsx**

In the left pane `ResizablePanel`, add cases for the new view types:

```tsx
import { ServicesManage } from "./components/ServicesManage.js";
import { VersionHistory } from "./components/VersionHistory.js";
import { DiscoveryProgress } from "./components/DiscoveryProgress.js";
import { DiscoveryReview } from "./components/DiscoveryReview.js";

// In the left pane switch:
{leftPane.type === "services:manage" ? (
  <ServicesManage
    onRunDiscovery={() => {
      ws.send({ type: "discover" });
      setLeftPane({ type: "services:discovery" });
    }}
    onViewHistory={() => setLeftPane({ type: "services:history" })}
    onBack={() => setLeftPane({ type: "dashboard" })}
  />
) : leftPane.type === "services:history" ? (
  <VersionHistory
    onBack={() => setLeftPane({ type: "services:manage" })}
  />
) : leftPane.type === "services:discovery" ? (
  <DiscoveryProgress
    phase={discoveryState.phase}
    phaseStatus={discoveryState.status}
    iteration={discoveryState.iteration}
    toolCalls={discoveryState.toolCalls}
    onBack={() => setLeftPane({ type: "services:manage" })}
  />
) : leftPane.type === "services:review" ? (
  <DiscoveryReview
    services={discoveryState.results}
    onAccept={(services) => {
      ws.send({ type: "discover:accept", services });
      setLeftPane({ type: "dashboard" });
    }}
    onReject={() => {
      ws.send({ type: "discover:reject" });
      setLeftPane({ type: "dashboard" });
    }}
    onBack={() => setLeftPane({ type: "services:manage" })}
  />
) : /* ...existing cases... */}
```

- [ ] **Step 4: Add FirstRunBanner and ServicesSection to Dashboard**

In `src/web/components/Dashboard.tsx`:

```tsx
import { useState } from "react";
import { FirstRunBanner } from "./FirstRunBanner.js";
import { ServicesSection } from "./ServicesSection.js";

// Add props:
interface DashboardProps {
  onInvestigationClick: (id: string) => void;
  onInvestigateService: (serviceName: string) => void;
  onManageServices: () => void;
  onRunDiscovery: () => void;
}

// In the component:
const [bannerDismissed, setBannerDismissed] = useState(false);

// Before the services grid, add:
{services.length === 0 && !bannerDismissed && (
  <FirstRunBanner
    onRunDiscovery={onRunDiscovery}
    onDismiss={() => setBannerDismissed(true)}
  />
)}

// After the investigations section, add:
<ServicesSection
  services={services}
  onManage={onManageServices}
  onRediscover={onRunDiscovery}
/>
```

- [ ] **Step 5: Update Dashboard props in App.tsx**

Pass new props to Dashboard:

```tsx
<Dashboard
  onInvestigationClick={(id) => setLeftPane({ type: "investigation", id })}
  onInvestigateService={(serviceName) => {
    ws.send({ type: "chat", message: `investigate ${serviceName}` });
  }}
  onManageServices={() => setLeftPane({ type: "services:manage" })}
  onRunDiscovery={() => {
    ws.send({ type: "discover" });
    setLeftPane({ type: "services:discovery" });
  }}
/>
```

- [ ] **Step 6: Build web and type check**

Run: `npx tsc --noEmit && npm run build:web`
Expected: No type errors, build succeeds

- [ ] **Step 7: Commit**

```bash
git add src/web/App.tsx src/web/components/Dashboard.tsx
git commit -m "feat: wire services views into Dashboard and App routing"
```

---

### Task 20: Final Integration Test

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Build web**

Run: `npm run build:web`
Expected: Build succeeds

- [ ] **Step 4: Verify spec file is committed**

```bash
git add docs/superpowers/specs/2026-03-14-discover-agent-design.md
git commit -m "docs: add discover agent design spec"
```

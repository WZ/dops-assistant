# Service Discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the agent auto-discover services from Prometheus/Consul and generate ServiceConfig entries, replacing manual config.yaml authoring.

**Architecture:** A `DiscoveryAgent` reuses `InvestigationAgent.runPhase()` pattern — LLM + MCP tools + structured JSON output. Two entry points: interactive CLI (`npm run discover`) and optional startup auto-refresh.

**Tech Stack:** TypeScript, Zod, Ink (CLI), existing LlmClient + McpClient, YAML serialization.

---

### Task 1: Add DiscoveryConfig to config schema

**Files:**
- Modify: `src/config/schema.ts:107-118`
- Test: `src/config/schema.test.ts`

**Step 1: Write the failing test**

In `src/config/schema.test.ts`, add a test that validates a config with the `discovery` section:

```typescript
it("accepts discovery config with defaults", () => {
  const result = ConfigSchema.safeParse({
    ...minimalConfig,
    discovery: {
      excludeServices: ["consul", "prometheus"],
      consulMetric: "consul_catalog_service_node_healthy",
    },
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.discovery.autoRefresh).toBe(false);
    expect(result.data.discovery.excludeServices).toEqual(["consul", "prometheus"]);
  }
});
```

Where `minimalConfig` is the minimal valid config object already used in existing tests (has `llm` and `grafana` keys).

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/schema.test.ts`
Expected: FAIL — `discovery` property not recognized in schema.

**Step 3: Add DiscoverySchema to `src/config/schema.ts`**

Add before `ConfigSchema`:

```typescript
const DiscoverySchema = z.object({
  autoRefresh: z.boolean().default(false),
  excludeServices: z.array(z.string()).default([]),
  consulMetric: z.string().default("consul_catalog_service_node_healthy"),
});
```

Add to `ConfigSchema.z.object({...})`:

```typescript
  discovery: DiscoverySchema.optional().default({}),
```

Export the type:

```typescript
export type DiscoveryConfig = z.infer<typeof DiscoverySchema>;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/schema.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config/schema.ts src/config/schema.test.ts
git commit -m "feat(config): add discovery schema with autoRefresh, excludeServices, consulMetric"
```

---

### Task 2: Create discovery prompt and JSON response schema

**Files:**
- Create: `src/agent/discovery-prompts.ts`
- Test: `src/agent/discovery-prompts.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { DISCOVERY_PROMPT, DISCOVERED_SERVICES_SCHEMA, buildDiscoveryUserMessage } from "./discovery-prompts.js";
import type { DiscoveryConfig } from "../config/schema.js";

describe("discovery-prompts", () => {
  it("DISCOVERY_PROMPT is a non-empty string", () => {
    expect(DISCOVERY_PROMPT.length).toBeGreaterThan(100);
  });

  it("DISCOVERED_SERVICES_SCHEMA has correct structure", () => {
    expect(DISCOVERED_SERVICES_SCHEMA.type).toBe("json_schema");
    expect(DISCOVERED_SERVICES_SCHEMA.json_schema.name).toBe("discovered_services");
  });

  it("buildDiscoveryUserMessage includes consul metric and exclusions", () => {
    const cfg: DiscoveryConfig = {
      autoRefresh: false,
      excludeServices: ["consul", "grafana"],
      consulMetric: "consul_catalog_service_node_healthy",
    };
    const msg = buildDiscoveryUserMessage(cfg);
    expect(msg).toContain("consul_catalog_service_node_healthy");
    expect(msg).toContain("consul");
    expect(msg).toContain("grafana");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/discovery-prompts.test.ts`
Expected: FAIL — module not found.

**Step 3: Create `src/agent/discovery-prompts.ts`**

```typescript
import type { ResponseFormat } from "../llm/openai.js";
import type { DiscoveryConfig } from "../config/schema.js";

export const DISCOVERY_PROMPT = `You are a service discovery agent. Your job is to discover services monitored in this Grafana/Prometheus environment and generate configuration for each.

For each discovered service, produce:
- name: a short identifier (e.g. "payments-api", "user-service")
- metrics: an array of useful Prometheus queries with descriptions. Focus on RED signals:
  - Request rate (e.g. rate(http_requests_total{...}[5m]))
  - Error rate (e.g. rate(http_requests_total{status=~"5.."}[5m]))
  - Latency (e.g. histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{...}[5m])))
  Only include metrics that actually exist — verify by querying them.
- logLabels: key-value pairs for querying this service's logs in Loki. Try common label names (app, service, job) and verify which ones return results.

Strategy:
1. Query the consul metric to get a list of service names
2. For each service (excluding infrastructure services listed below):
   a. Use list_prometheus_metric_metadata or query_prometheus to find metrics matching the service name (try job label, service label, and other common patterns)
   b. Select the most useful RED metrics and write working PromQL queries
   c. Query Loki to find log labels that match this service
3. Return ALL discovered services as a JSON array

Important:
- Only include metrics you have verified exist by querying them
- Write complete, working PromQL queries (not templates)
- If a service has no discoverable metrics or logs, still include it with empty arrays — it can be enriched later

Respond ONLY with valid JSON matching the required schema.`;

export const DISCOVERED_SERVICES_SCHEMA: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "discovered_services",
    strict: true,
    schema: {
      type: "object",
      properties: {
        services: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              metrics: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["query", "description"],
                  additionalProperties: false,
                },
              },
              logLabels: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
            required: ["name", "metrics", "logLabels"],
            additionalProperties: false,
          },
        },
      },
      required: ["services"],
      additionalProperties: false,
    },
  },
};

export function buildDiscoveryUserMessage(config: DiscoveryConfig): string {
  const parts = [
    `Discover services using the Prometheus metric: ${config.consulMetric}`,
    `Query: ${config.consulMetric} to find all service names.`,
  ];
  if (config.excludeServices.length > 0) {
    parts.push(`Exclude these infrastructure services: ${config.excludeServices.join(", ")}`);
  }
  return parts.join("\n");
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/discovery-prompts.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/discovery-prompts.ts src/agent/discovery-prompts.test.ts
git commit -m "feat(discovery): add discovery prompt and JSON response schema"
```

---

### Task 3: Create DiscoveryAgent class

**Files:**
- Create: `src/agent/discovery.ts`
- Test: `src/agent/discovery.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { DiscoveryAgent } from "./discovery.js";
import type { LlmClient } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import type { DiscoveryConfig } from "../config/schema.js";

function mockLlm(response: string): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({
      type: "text",
      content: response,
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  } as unknown as LlmClient;
}

function mockMcp(): McpClient {
  return {
    getTools: vi.fn().mockReturnValue([]),
    callTool: vi.fn().mockResolvedValue({ text: "", images: [] }),
  } as unknown as McpClient;
}

const discoveryConfig: DiscoveryConfig = {
  autoRefresh: false,
  excludeServices: ["consul"],
  consulMetric: "consul_catalog_service_node_healthy",
};

describe("DiscoveryAgent", () => {
  it("returns discovered services from LLM response", async () => {
    const response = JSON.stringify({
      services: [
        {
          name: "payments-api",
          metrics: [{ query: 'rate(http_requests_total{job="payments-api"}[5m])', description: "Request rate" }],
          logLabels: { app: "payments-api" },
        },
      ],
    });
    const agent = new DiscoveryAgent(mockLlm(response), mockMcp(), { maxIterations: 10 });
    const result = await agent.discover(discoveryConfig);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("payments-api");
    expect(result[0]!.metrics).toHaveLength(1);
  });

  it("calls onTokenUsage callback", async () => {
    const response = JSON.stringify({ services: [] });
    const agent = new DiscoveryAgent(mockLlm(response), mockMcp(), { maxIterations: 10 });
    const onTokenUsage = vi.fn();
    await agent.discover(discoveryConfig, onTokenUsage);
    expect(onTokenUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 50 });
  });

  it("filters excluded services from results", async () => {
    const response = JSON.stringify({
      services: [
        { name: "consul", metrics: [], logLabels: {} },
        { name: "payments-api", metrics: [], logLabels: {} },
      ],
    });
    const agent = new DiscoveryAgent(mockLlm(response), mockMcp(), { maxIterations: 10 });
    const result = await agent.discover(discoveryConfig);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("payments-api");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/discovery.test.ts`
Expected: FAIL — module not found.

**Step 3: Create `src/agent/discovery.ts`**

```typescript
import type { LlmClient, Message, TokenUsage } from "../llm/openai.js";
import type { McpClient } from "../mcp/client.js";
import type { ServiceConfig, DiscoveryConfig } from "../config/schema.js";
import { sanitizeToolResult } from "./core.js";
import {
  DISCOVERY_PROMPT,
  DISCOVERED_SERVICES_SCHEMA,
  buildDiscoveryUserMessage,
} from "./discovery-prompts.js";

type DiscoveredServices = {
  services: Array<{
    name: string;
    metrics: Array<{ query: string; description: string }>;
    logLabels: Record<string, string>;
  }>;
};

export class DiscoveryAgent {
  private readonly llm: LlmClient;
  private readonly mcp: McpClient;
  private readonly maxIterations: number;

  constructor(llm: LlmClient, mcp: McpClient, opts: { maxIterations: number }) {
    this.llm = llm;
    this.mcp = mcp;
    this.maxIterations = opts.maxIterations;
  }

  async discover(
    config: DiscoveryConfig,
    onTokenUsage?: (usage: TokenUsage) => void,
    onToolCall?: (name: string, args: Record<string, unknown>) => void,
  ): Promise<ServiceConfig[]> {
    const tools = this.mcp.getTools();
    const messages: Message[] = [
      { role: "system", content: DISCOVERY_PROMPT },
      { role: "user", content: buildDiscoveryUserMessage(config) },
    ];

    for (let i = 0; i < this.maxIterations; i++) {
      const response = await this.llm.chat(messages, tools, {
        responseFormat: DISCOVERED_SERVICES_SCHEMA,
      });

      if (response.usage) onTokenUsage?.(response.usage);

      if (response.type === "text") {
        const parsed = JSON.parse(response.content) as DiscoveredServices;
        const excludeSet = new Set(config.excludeServices.map((s) => s.toLowerCase()));
        return parsed.services
          .filter((s) => !excludeSet.has(s.name.toLowerCase()))
          .map((s) => ({
            name: s.name,
            metrics: s.metrics,
            logLabels: s.logLabels,
          }));
      }

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: response.calls.map((c) => ({
          id: c.id, name: c.name, args: c.args,
        })),
      });

      for (const call of response.calls) {
        onToolCall?.(call.name, call.args);
      }

      const settled = await Promise.allSettled(
        response.calls.map((call) => this.mcp.callTool(call.name, call.args)),
      );
      for (let j = 0; j < response.calls.length; j++) {
        const outcome = settled[j]!;
        const call = response.calls[j]!;
        messages.push({
          role: "tool",
          content: outcome.status === "fulfilled"
            ? sanitizeToolResult(outcome.value.text)
            : `[Error] ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          tool_call_id: call.id,
        });
      }
    }

    throw new Error(`Discovery did not complete within ${this.maxIterations} iterations`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/discovery.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/discovery.ts src/agent/discovery.test.ts
git commit -m "feat(discovery): add DiscoveryAgent with LLM-driven service probing"
```

---

### Task 4: Create `npm run discover` CLI entry point

**Files:**
- Create: `src/discover.tsx`
- Modify: `package.json` (add script)

**Step 1: Create `src/discover.tsx`**

This follows the same pattern as `src/cli.tsx` — dotenv, MCP connect, then run discovery and write results.

```tsx
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

const envPath = process.env["DOTENV_PATH"] ?? resolve(process.cwd(), "dev/.env");
loadDotenv({ path: envPath });

if (!process.env["LOG_LEVEL"]) {
  process.env["LOG_LEVEL"] = "silent";
}

import React, { useState, useEffect } from "react";
import { render, Box, Text, Static } from "ink";
import { Spinner } from "@inkjs/ui";
import { readFileSync, writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { loadConfig } from "./config/loader.js";
import { McpClient } from "./mcp/client.js";
import { LlmClient } from "./llm/openai.js";
import { DiscoveryAgent } from "./agent/discovery.js";
import type { ServiceConfig } from "./config/schema.js";
import type { TokenUsage } from "./llm/openai.js";

const configPath = process.env["CONFIG_PATH"] ?? "dev/config.yaml";

type LogEntry = { id: number; text: string };

function DiscoverApp() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [services, setServices] = useState<ServiceConfig[]>([]);
  const [spinnerLabel, setSpinnerLabel] = useState("Connecting to MCP...");

  const log = (text: string) => {
    setLogs((prev) => [...prev, { id: prev.length, text }]);
  };

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const config = loadConfig(configPath);
        const mcp = new McpClient(config.grafana.mcpServer, config.timeouts);
        await mcp.connect();
        if (cancelled) return;

        log(`Connected to MCP (${mcp.getTools().length} tools)`);

        const llm = new LlmClient(config.llm, config.timeouts, config.retry);
        const agent = new DiscoveryAgent(llm, mcp, { maxIterations: config.agent.maxIterations });

        setSpinnerLabel("Discovering services...");

        const onTokenUsage = (usage: TokenUsage) => {
          log(`  tokens: ${usage.inputTokens + usage.outputTokens} (${usage.inputTokens} in / ${usage.outputTokens} out)`);
        };
        const onToolCall = (name: string, args: Record<string, unknown>) => {
          log(`  ${name}(${JSON.stringify(args).slice(0, 80)})`);
        };

        const discovered = await agent.discover(config.discovery, onTokenUsage, onToolCall);
        if (cancelled) return;

        // Merge: static services take precedence
        const staticNames = new Set(config.services.map((s) => s.name));
        const newServices = discovered.filter((s) => !staticNames.has(s.name));
        const merged = [...config.services, ...newServices];

        setServices(merged);

        if (newServices.length === 0) {
          log("No new services discovered beyond static config.");
        } else {
          log(`Discovered ${newServices.length} new service(s):`);
          for (const s of newServices) {
            log(`  - ${s.name}: ${s.metrics.length} metrics, ${Object.keys(s.logLabels).length} log labels`);
          }

          // Write back to config
          const raw = readFileSync(configPath, "utf-8");
          const servicesYaml = stringify({ services: merged }, { indent: 2 });
          const updated = raw.replace(
            /^services:.*?(?=\n\S|\n*$)/ms,
            servicesYaml.trimEnd(),
          );
          writeFileSync(configPath, updated);
          log(`Updated ${configPath} with ${merged.length} services.`);
        }

        await mcp.disconnect();
        setStatus("done");
      } catch (err) {
        log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        setStatus("error");
      }
    }

    run();
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <Static items={logs}>
        {(entry) => (
          <Text key={entry.id} dimColor>{"  "}{entry.text}</Text>
        )}
      </Static>
      <Box paddingX={1}>
        {status === "running" && <Spinner label={spinnerLabel} />}
        {status === "done" && (
          <Text color="green">
            Discovery complete — {services.length} service(s) in config.
          </Text>
        )}
        {status === "error" && (
          <Text color="red">Discovery failed. See errors above.</Text>
        )}
      </Box>
    </>
  );
}

render(<DiscoverApp />);
```

**Step 2: Add script to package.json**

Add to `scripts` section:

```json
"discover": "NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 tsx src/discover.tsx"
```

**Step 3: Run type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Manual test**

Run: `CONFIG_PATH=dev/config.yaml npm run discover`
Expected: Connects to MCP, runs discovery, prints discovered services, writes to config.yaml.

**Step 5: Commit**

```bash
git add src/discover.tsx package.json
git commit -m "feat(discovery): add interactive CLI entry point (npm run discover)"
```

---

### Task 5: Add startup auto-refresh to `src/index.ts`

**Files:**
- Modify: `src/index.ts:17-54`

**Step 1: Add discovery import and auto-refresh logic**

After MCP connect and LLM client creation (line 40), add:

```typescript
import { DiscoveryAgent } from "./agent/discovery.js";

// ... inside main(), after LLM client creation:

let services = config.services;
if (config.discovery.autoRefresh) {
  logger.info("Running service auto-discovery...");
  try {
    const discoveryAgent = new DiscoveryAgent(llm, mcp, { maxIterations: config.agent.maxIterations });
    const discovered = await discoveryAgent.discover(config.discovery);
    const staticNames = new Set(services.map((s) => s.name));
    const newServices = discovered.filter((s) => !staticNames.has(s.name));
    services = [...services, ...newServices];
    logger.info({ discovered: newServices.length, total: services.length }, "Service discovery complete");
  } catch (err) {
    logger.warn({ err }, "Service discovery failed, using static config only");
  }
}
```

Then replace all references to `config.services` with `services` (used in Scheduler and SlackBot constructors).

**Step 2: Run type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(discovery): add optional startup auto-refresh for service discovery"
```

---

### Task 6: Update dev/config.yaml with discovery section

**Files:**
- Modify: `dev/config.yaml`

**Step 1: Add discovery section to config**

Add after `services: []`:

```yaml
discovery:
  autoRefresh: false
  excludeServices:
    - consul
    - prometheus
    - grafana
    - node-exporter
    - alertmanager
  consulMetric: consul_catalog_service_node_healthy
```

**Step 2: Verify config loads**

Run: `node -e "import('./src/config/loader.js').then(m => { const c = m.loadConfig('dev/config.yaml'); console.log('discovery:', JSON.stringify(c.discovery)) })"`
Expected: Prints the discovery config with defaults applied.

**Step 3: Commit**

```bash
git add dev/config.yaml
git commit -m "chore(config): add discovery section with default exclusions"
```

---

### Task 7: End-to-end manual verification

**Step 1: Run discovery CLI**

```bash
CONFIG_PATH=dev/config.yaml npm run discover
```

Expected: Agent connects to MCP, queries Prometheus for consul_catalog_service_node_healthy, discovers services, probes for metrics and log labels, writes results to config.yaml.

**Step 2: Verify config.yaml was updated**

```bash
cat dev/config.yaml
```

Expected: `services:` section populated with discovered services.

**Step 3: Start CLI and test with a discovered service**

```bash
CONFIG_PATH=dev/config.yaml npm run cli
```

Then type: `investigate <discovered-service-name>`

Expected: Investigation runs using the auto-discovered metrics and log labels.

**Step 4: Run full test suite**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: All tests pass, no type errors.

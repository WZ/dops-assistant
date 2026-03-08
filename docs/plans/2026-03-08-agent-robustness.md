# Agent Robustness Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix intent classification (4-9/10 → 10/10), service matching (4/10 → 9/10), and investigation reliability (missing evidence, timeouts, truncation).

**Architecture:** Eight independent fixes across three layers: intent routing (`intent.ts`, `rca-prompts.ts`), service resolution (`intent.ts`), and investigation pipeline (`investigation.ts`).

**Tech Stack:** TypeScript, Vitest, pino

---

### Task 1: Fix `matchServiceFromText` — exact name match priority

**Files:**
- Modify: `src/agent/intent.ts:67-91`
- Test: `src/agent/intent.test.ts`

**Problem:** "data-server" matches `data-catalog-server-headless` (more token overlap) instead of `data-server` (exact). "faz-web-server" matches `faz-web-proxy` instead of `faz-web-server`.

**Step 1: Write the failing tests**

Add to the `matchServiceFromText` describe block in `src/agent/intent.test.ts`:

```typescript
it("prefers exact service name over longer name with more tokens", () => {
  const svcs = [svc("data-catalog-server-headless"), svc("data-server"), svc("data-catalog-server")];
  expect(matchServiceFromText("data-server queries are slow", svcs)?.name).toBe("data-server");
});

it("prefers faz-web-server over faz-web-proxy when user says faz-web-server", () => {
  const svcs = [svc("faz-web-proxy"), svc("faz-web-server")];
  expect(matchServiceFromText("check faz-web-server for issues", svcs)?.name).toBe("faz-web-server");
});

it("matches hyphenated service name split across message tokens", () => {
  const svcs = [svc("ingestion-server"), svc("data-server")];
  expect(matchServiceFromText("the ingestion-server is throwing errors", svcs)?.name).toBe("ingestion-server");
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/intent.test.ts`
Expected: 3 new tests FAIL

**Step 3: Implement the fix**

In `src/agent/intent.ts`, replace `matchServiceFromText` (lines 67-91) with:

```typescript
export function matchServiceFromText(text: string, services: ServiceConfig[]): ServiceConfig | undefined {
  const normalized = normalizeHyphens(text).toLowerCase();

  // Phase 1: Check if the full service name appears as a substring in the text.
  // Prefer the longest matching name to avoid "data-server" matching when "data-catalog-server" is present.
  const substringMatches = services
    .filter((s) => normalized.includes(normalizeHyphens(s.name).toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  if (substringMatches.length > 0) return substringMatches[0];

  // Phase 2: Token overlap scoring (original logic, for partial matches)
  const tokens = normalized
    .split(/[-_\s.,;:!?'"()]+/)
    .filter((t) => t.length >= 3);

  let bestMatch: ServiceConfig | undefined;
  let bestScore = 0;

  for (const s of services) {
    const sTokens = normalizeHyphens(s.name).toLowerCase().split(/[-_\s]+/).filter((t) => t.length >= 3);
    let score = 0;
    for (const st of sTokens) {
      for (const t of tokens) {
        if (st === t) { score += 3; break; }
        if (st.length >= 5 && t.length >= 5 && (st.includes(t) || t.includes(st))) { score += 1; break; }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = s;
    }
  }

  return bestMatch && bestScore >= 3 ? bestMatch : undefined;
}
```

**Step 4: Run tests**

Run: `npx vitest run src/agent/intent.test.ts`
Expected: ALL pass

**Step 5: Commit**

```bash
git add src/agent/intent.ts src/agent/intent.test.ts
git commit -m "fix: matchServiceFromText prefers exact name substring over token overlap"
```

---

### Task 2: Fix `matchService` — prefer shortest containing match

**Files:**
- Modify: `src/agent/intent.ts:22-60`
- Test: `src/agent/intent.test.ts`

**Problem:** "kafka" → `stream-kafka-cluster-cruise-control` (first `.find()` match). Should prefer shorter/better matches. "clickhouse" → `clickhouse-sinker` instead of `ch-clickhouse`.

**Step 1: Write the failing tests**

Add to the `matchService` describe block:

```typescript
it("prefers shorter service name when multiple contain the query", () => {
  const svcs = [svc("stream-kafka-cluster-cruise-control"), svc("stream-kafka-cluster-kafka-brokers"), svc("kafka-exporter")];
  // "kafka" as a complete service name component — prefer shortest containing match
  expect(matchService("kafka", svcs)?.name).toBe("kafka-exporter");
});

it("matches ch-clickhouse over clickhouse-sinker for 'clickhouse'", () => {
  const svcs = [svc("clickhouse-sinker"), svc("ch-clickhouse"), svc("ch-clickhouse-headless")];
  expect(matchService("clickhouse", svcs)?.name).toBe("ch-clickhouse");
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/intent.test.ts`
Expected: 2 new tests FAIL

**Step 3: Implement the fix**

In `src/agent/intent.ts`, replace the substring matching section (lines 34-40) with:

```typescript
  // Service name contains query — prefer shortest match (most specific)
  const containsMatches = services.filter((s) => normalizeHyphens(s.name).toLowerCase().includes(q));
  if (containsMatches.length > 0) {
    containsMatches.sort((a, b) => a.name.length - b.name.length);
    return containsMatches[0];
  }

  // Query contains service name — prefer longest match (most specific)
  const reverseMatches = services.filter((s) => q.includes(normalizeHyphens(s.name).toLowerCase()));
  if (reverseMatches.length > 0) {
    reverseMatches.sort((a, b) => b.name.length - a.name.length);
    return reverseMatches[0];
  }
```

**Step 4: Run tests**

Run: `npx vitest run src/agent/intent.test.ts`
Expected: ALL pass

**Step 5: Commit**

```bash
git add src/agent/intent.ts src/agent/intent.test.ts
git commit -m "fix: matchService prefers shortest/longest containing match"
```

---

### Task 3: Add service aliases for common LLM shorthand

**Files:**
- Modify: `src/agent/intent.ts`
- Test: `src/agent/intent.test.ts`

**Problem:** LLM returns "kafka", "clickhouse", "postgres", "redis" but these don't directly match any service name after Task 2 fix. Need explicit alias mapping.

**Step 1: Write the failing tests**

Add to the `matchService` describe block:

```typescript
it("resolves alias 'kafka' to a kafka-brokers service", () => {
  const svcs = [svc("stream-kafka-cluster-cruise-control"), svc("stream-kafka-cluster-kafka-brokers")];
  expect(matchService("kafka", svcs)?.name).toBe("stream-kafka-cluster-kafka-brokers");
});

it("resolves alias 'postgres' to stolon-proxy", () => {
  const svcs = [svc("stolon-proxy"), svc("stolon-keeper-headless")];
  expect(matchService("postgres", svcs)?.name).toBe("stolon-proxy");
});

it("resolves alias 'redis' to cache-redis-ha", () => {
  const svcs = [svc("cache-redis-ha"), svc("cache-redis-ha-haproxy")];
  expect(matchService("redis", svcs)?.name).toBe("cache-redis-ha");
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/intent.test.ts`
Expected: 3 new tests FAIL

**Step 3: Implement**

Add at the top of `matchService`, after the `const q = ...` line:

```typescript
  // Common aliases: LLMs return shorthand names for well-known infrastructure
  const ALIASES: Record<string, string[]> = {
    kafka: ["kafka-brokers", "kafka-bootstrap"],
    clickhouse: ["ch-clickhouse"],
    postgres: ["stolon-proxy"],
    postgresql: ["stolon-proxy"],
    stolon: ["stolon-proxy"],
    redis: ["cache-redis-ha"],
    ingestion: ["ingestion-server"],
  };
  const aliasTargets = ALIASES[q];
  if (aliasTargets) {
    for (const target of aliasTargets) {
      const aliased = services.find((s) => normalizeHyphens(s.name).toLowerCase().includes(target));
      if (aliased) return aliased;
    }
  }
```

**Step 4: Run tests**

Run: `npx vitest run src/agent/intent.test.ts`
Expected: ALL pass

**Step 5: Commit**

```bash
git add src/agent/intent.ts src/agent/intent.test.ts
git commit -m "feat: add service aliases for common LLM shorthand names"
```

---

### Task 4: Strengthen intent classifier prompt

**Files:**
- Modify: `src/agent/rca-prompts.ts:166-178`
- Test: `src/agent/rca-prompts.test.ts`

**Problem:** Intent classification is non-deterministic (4/10 to 9/10). The prompt doesn't clearly define boundaries or provide examples.

**Step 1: Write the failing tests**

Add to the `buildIntentClassifierPrompt` tests in `src/agent/rca-prompts.test.ts`:

```typescript
it("includes few-shot examples for investigation vs question", () => {
  const prompt = buildIntentClassifierPrompt();
  expect(prompt).toContain("EXAMPLES");
  expect(prompt).toContain("throwing errors");
  expect(prompt).toContain("what dashboards");
});

it("includes symptom and error patterns as investigation triggers", () => {
  const prompt = buildIntentClassifierPrompt();
  expect(prompt).toContain("slow");
  expect(prompt).toContain("error");
  expect(prompt).toContain("check");
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/rca-prompts.test.ts`
Expected: 2 new tests FAIL

**Step 3: Replace `buildIntentClassifierPrompt`**

In `src/agent/rca-prompts.ts`, replace lines 166-178:

```typescript
export function buildIntentClassifierPrompt(serviceNames?: string[]): string {
  const serviceList = serviceNames?.length
    ? `\nFor reference, known services include: ${serviceNames.join(", ")}\nIf the user mentions a service or component, extract the key identifying term (e.g. "ingestion log rate drop" → "ingestion", "kudu tserver is slow" → "kudu-tserver"). Prefer using a known service name if it clearly matches, but you may also extract the user's own wording.`
    : "";

  return `You are classifying a user message as either an "investigation" request or a "question".

CLASSIFY AS "investigation" when the user:
- Reports a problem, symptom, or error (slow, down, failing, errors, spike, drop, timeout, OOM, crash)
- Asks to investigate, diagnose, troubleshoot, or check a service/component
- Describes an anomaly or unexpected behavior
- Asks to check health, performance, or status of a specific service
- Uses words like: investigate, check, diagnose, troubleshoot, look into, what's wrong, why is

CLASSIFY AS "question" when the user:
- Asks for information without implying a problem ("what dashboards do we have?", "list services")
- Asks how something works ("how does ingestion work?")
- Asks for general status without concern ("show me the current metrics")

EXAMPLES:
- "data-server queries are running slow" → investigation, service: "data-server"
- "check ClickHouse cluster health" → investigation, service: "clickhouse"
- "data-server is throwing ClickHouse connection errors" → investigation, service: "data-server"
- "something seems off with the system, investigate" → investigation, service: ""
- "are there any issues with the Kafka cluster?" → investigation, service: "kafka"
- "check CPU usage across all nodes" → investigation, service: ""
- "what dashboards do we have available?" → question, service: ""
- "how does the ingestion pipeline work?" → question, service: ""

When in doubt, classify as "investigation" — it's better to investigate and find nothing than to miss a real issue.
${serviceList}
Extract the service name if mentioned. Respond ONLY with valid JSON matching the required schema.`;
}
```

**Step 4: Run tests**

Run: `npx vitest run src/agent/rca-prompts.test.ts`
Expected: ALL pass

**Step 5: Commit**

```bash
git add src/agent/rca-prompts.ts src/agent/rca-prompts.test.ts
git commit -m "fix: strengthen intent classifier with examples and symptom patterns"
```

---

### Task 5: Bump evidence phase timeouts to 180s

**Files:**
- Modify: `src/agent/investigation.ts:416-419`

**Problem:** Log/metric/infra phases time out at 120s in ~60% of runs with slow models.

**Step 1: Add timeout to evidence phase calls**

Near `EVIDENCE_ITERATIONS` (line 414), add:

```typescript
const EVIDENCE_TIMEOUT_MS = 180_000; // 3min — evidence phases need headroom for slow models
```

Then update the three `runPhase` calls (lines 417-419) to pass the timeout:

```typescript
const [metricResult, logResult, infraResult, panelCaptureResult] = await Promise.allSettled([
  this.runPhase<MetricFindings>(metricPrompt, metricMessageFull, METRIC_FINDINGS_SCHEMA, EVIDENCE_ITERATIONS, onTokenUsage, onToolCall, true, EVIDENCE_MAX_TOKENS, EVIDENCE_TIMEOUT_MS),
  this.runPhase<LogFindings>(logPrompt, logMessageFull, LOG_FINDINGS_SCHEMA, EVIDENCE_ITERATIONS, onTokenUsage, onToolCall, true, EVIDENCE_MAX_TOKENS, EVIDENCE_TIMEOUT_MS),
  this.runPhase<InfraFindings>(infraPrompt, infraMessageFull, INFRA_FINDINGS_SCHEMA, EVIDENCE_ITERATIONS, onTokenUsage, onToolCall, true, EVIDENCE_MAX_TOKENS, EVIDENCE_TIMEOUT_MS),
  this.capturePanelImages(service.name, anomaly.summary, userMessage, onToolCall),
]);
```

**Step 2: Run tests**

Run: `npx vitest run src/agent/investigation.test.ts`
Expected: ALL pass (no behavior change, just timeout increase)

**Step 3: Commit**

```bash
git add src/agent/investigation.ts
git commit -m "fix: bump evidence phase timeout to 180s for slow models"
```

---

### Task 6: Fix planning phase max_output_tokens

**Files:**
- Modify: `src/agent/investigation.ts:341-349`

**Problem:** Planning phase truncates at 128 tokens (default `config.maxTokens` override is not set, so it falls through to the LlmConfig default which may be low). The planning `runPhase` call has no `maxOutputTokens` parameter, so it uses the config default.

**Step 1: Add maxOutputTokens to planning phase**

Update the planning `runPhase` call (line 341-349):

```typescript
    const PLAN_MAX_TOKENS = 2048;
    const planResult = await this.runPhase<InvestigationPlan>(
      INVESTIGATION_PLAN_PROMPT,
      planMessage,
      INVESTIGATION_PLAN_SCHEMA,
      3,
      onTokenUsage,
      onToolCall,
      false, // planning is pure reasoning, no tools needed
      PLAN_MAX_TOKENS,
    );
```

**Step 2: Run tests**

Run: `npx vitest run src/agent/investigation.test.ts`
Expected: ALL pass

**Step 3: Commit**

```bash
git add src/agent/investigation.ts
git commit -m "fix: set planning phase maxOutputTokens to 2048"
```

---

### Task 7: Remove `list_prometheus_metric_metadata` from excluded tools

**Files:**
- Modify: `src/agent/investigation.ts:1140-1150`

**Problem:** Excluded from tool set, but model hallucinates it every run (3-4 times), wasting iterations. Better to let the model call it and handle the 404 gracefully.

**Step 1: Remove from excludedTools**

In `runPhase` (line ~1145), remove `list_prometheus_metric_metadata` from the set:

```typescript
    const excludedTools = new Set([
      "list_datasources",
      "search_dashboards",
      "get_dashboard_panel_queries",
      "get_dashboard_by_uid",
      // list_prometheus_metric_metadata: re-enabled — excluding it causes hallucinated calls that waste iterations
      "list_alert_rules",                 // Grafana-managed: empty; datasource-managed: 500
      "get_alert_rule_by_uid",
      "list_loki_label_names",            // Pre-fetched into context
      "list_loki_label_values",           // Rarely worth an iteration; labels provided in context
    ]);
```

**Step 2: Run tests**

Run: `npx vitest run src/agent/investigation.test.ts`
Expected: ALL pass

**Step 3: Commit**

```bash
git add src/agent/investigation.ts
git commit -m "fix: re-enable list_prometheus_metric_metadata to stop hallucinated calls"
```

---

### Task 8: Bump reflection max_output_tokens to 8192

**Files:**
- Modify: `src/agent/investigation.ts:581`

**Problem:** Reflection truncates at 4096 tokens when report is large, causing JSON parse failures.

**Step 1: Change REFLECTION_MAX_TOKENS**

Line 581: change `const REFLECTION_MAX_TOKENS = 4096;` to:

```typescript
    const REFLECTION_MAX_TOKENS = 8192;
```

**Step 2: Run tests**

Run: `npx vitest run src/agent/investigation.test.ts`
Expected: ALL pass

**Step 3: Commit**

```bash
git add src/agent/investigation.ts
git commit -m "fix: bump reflection maxOutputTokens to 8192 to prevent truncation"
```

---

### Task 9: Rebuild, re-run test prompts, verify improvements

**Step 1: Build**

```bash
npm run build
```

**Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: ALL pass

**Step 3: Run intent/service test**

```bash
node bin/test-prompts.mjs
```

Expected: Intent accuracy ≥ 9/10, Service accuracy ≥ 8/10

**Step 4: Run one full investigation**

```bash
node bin/test-prompts.mjs --full 1
```

Expected: data-server investigation completes with evidence in logs, metrics, and infra.

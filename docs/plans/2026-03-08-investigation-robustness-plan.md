# Investigation Robustness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 systemic robustness issues to bring investigation success rate from 4/10 to 8-9/10.

**Architecture:** Three layered fixes: (1) LLM client retries on hallucinated empty responses, (2) higher token limits + JSON repair for truncation, (3) root-cause quality gate for non-conclusive synthesis. Fixes are in dependency order.

**Tech Stack:** TypeScript, Vitest, OpenAI Responses API (via gpt-oss-120b)

---

### Task 1: LLM Client — Retry on Hallucinated Empty Content

**Files:**
- Modify: `src/llm/openai.ts:302-335`
- Test: `src/llm/openai.test.ts`

**Step 1: Write the failing tests**

Add to `src/llm/openai.test.ts` inside the `LlmClient` describe block:

```typescript
it("retries when hallucinated function calls produce empty content (no tools provided)", async () => {
  const mockCreate = await getMockCreate();
  // First call: hallucinated function call with no text
  mockCreate.mockResolvedValueOnce({
    output: [
      { type: "function_call", call_id: "fake_1", name: "<|constrain|>json", arguments: "{}" },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  // Retry: returns valid text
  mockCreate.mockResolvedValueOnce({
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"result": "ok"}' }] },
    ],
    usage: { input_tokens: 110, output_tokens: 60 },
  });

  const client = new LlmClient(config, defaultTimeouts, defaultRetry);
  const result = await client.chat([{ role: "user", content: "Produce JSON." }], []);
  expect(result.type).toBe("text");
  expect(result.content).toBe('{"result": "ok"}');
  expect(mockCreate).toHaveBeenCalledTimes(2);
});

it("returns empty content after max hallucination retries exhausted", async () => {
  const mockCreate = await getMockCreate();
  // All 3 calls: hallucinated function calls with no text
  mockCreate.mockResolvedValue({
    output: [
      { type: "function_call", call_id: "fake_1", name: "<|constrain|>json", arguments: "{}" },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  const client = new LlmClient(config, defaultTimeouts, defaultRetry);
  const result = await client.chat([{ role: "user", content: "Produce JSON." }], []);
  expect(result.type).toBe("text");
  expect(result.content).toBe("");
  // Original + 2 retries = 3
  expect(mockCreate).toHaveBeenCalledTimes(3);
});

it("does not retry hallucinated calls when tools are provided", async () => {
  const mockCreate = await getMockCreate();
  mockCreate.mockResolvedValue({
    output: [
      { type: "function_call", call_id: "call_1", name: "query_prometheus", arguments: '{"query":"up"}' },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  const client = new LlmClient(config, defaultTimeouts, defaultRetry);
  const tools = [{ function: { name: "query_prometheus", description: "Query", parameters: {} } }];
  const result = await client.chat([{ role: "user", content: "Check." }], tools);
  expect(result.type).toBe("tool_calls");
  expect(mockCreate).toHaveBeenCalledTimes(1);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/llm/openai.test.ts`
Expected: 3 new tests FAIL

**Step 3: Implement hallucination retry in `doChat()`**

In `src/llm/openai.ts`, replace the hallucination handling block (lines ~302-335) with:

```typescript
    if (functionCalls.length > 0) {
      if (tools.length > 0) {
        return {
          type: "tool_calls",
          usage,
          calls: functionCalls.map((fc) => {
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(fc.arguments) as Record<string, unknown>;
            } catch {
              throw new Error(
                `Failed to parse tool arguments for "${fc.name}": ${fc.arguments}`,
              );
            }
            return { id: fc.id, name: fc.name, args };
          }),
        };
      } else {
        logger.warn(
          { hallucinated: functionCalls.map((fc) => fc.name) },
          "Ignoring hallucinated function calls (no tools were provided)",
        );
        // Retry if text content is empty — model tried to switch to JSON mode
        // but the serving layer interpreted control tokens as function calls
        if (!textContent && (retryCount ?? 0) < 2) {
          logger.info({ retryCount: (retryCount ?? 0) + 1 }, "Retrying with JSON nudge after hallucinated empty response");
          const nudge: ResponsesInputItem = {
            type: "message",
            role: "user",
            content: "Respond with valid JSON only. Do not call any functions.",
          };
          return this.doChat(messages, tools, opts, (retryCount ?? 0) + 1);
        }
      }
    }

    if (response.output.length === 0 && response.status !== "incomplete") {
      throw new Error(
        "LLM returned no output (possible content filter or API error)",
      );
    }

    return { type: "text", content: textContent, usage };
```

The key changes:
- Add `retryCount` parameter to `doChat()` signature (default 0)
- When hallucinated calls detected + empty textContent + retryCount < 2: append a nudge message to the input and recursively call `doChat` with incremented retryCount
- The nudge is appended to the existing `input` array before re-calling

Update the `doChat` signature:

```typescript
  private async doChat(
    messages: Message[],
    tools: OpenAITool[],
    opts?: { responseFormat?: ResponseFormat; maxOutputTokens?: number },
    retryCount?: number,
  ): Promise<LlmResponse> {
```

And in the retry path, append the nudge to the input before re-calling:

```typescript
        if (!textContent && (retryCount ?? 0) < 2) {
          logger.info({ retryCount: (retryCount ?? 0) + 1 }, "Retrying with JSON nudge after hallucinated empty response");
          // Append nudge to the original messages for retry
          const nudgedMessages: Message[] = [
            ...messages,
            { role: "user", content: "Respond with valid JSON only. Do not call any functions." },
          ];
          return this.doChat(nudgedMessages, tools, opts, (retryCount ?? 0) + 1);
        }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/llm/openai.test.ts`
Expected: All tests PASS (including 3 new ones)

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 6: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add src/llm/openai.ts src/llm/openai.test.ts
git commit -m "fix: retry LLM call on hallucinated empty-content responses"
```

---

### Task 2: Truncated JSON Repair Function

**Files:**
- Modify: `src/agent/investigation.ts` (add `repairTruncatedJson` export)
- Test: `src/agent/investigation.test.ts`

**Step 1: Write the failing tests**

Add to `src/agent/investigation.test.ts`:

```typescript
import { repairTruncatedJson } from "./investigation.js";

describe("repairTruncatedJson", () => {
  it("returns valid JSON unchanged", () => {
    const valid = '{"severity":"high","summary":"Error spike"}';
    expect(repairTruncatedJson(valid)).toBe(valid);
  });

  it("repairs truncated string value", () => {
    const truncated = '{"severity":"high","summary":"Error spike at 14:';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.severity).toBe("high");
    expect(parsed.summary).toContain("Error spike");
  });

  it("repairs truncated array", () => {
    const truncated = '{"items":["a","b","c';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.items).toContain("a");
    expect(parsed.items).toContain("b");
  });

  it("repairs truncated nested object", () => {
    const truncated = '{"impact":{"duration":"25 min","description":"Error';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.impact.duration).toBe("25 min");
  });

  it("repairs truncated mid-key", () => {
    const truncated = '{"severity":"high","summ';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.severity).toBe("high");
  });

  it("returns original string if unrepairable", () => {
    const garbage = "not json at all";
    expect(repairTruncatedJson(garbage)).toBe(garbage);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/investigation.test.ts`
Expected: New tests FAIL (repairTruncatedJson not exported)

**Step 3: Implement `repairTruncatedJson`**

Add to `src/agent/investigation.ts` (near the top, after the existing utility functions):

```typescript
/**
 * Attempt to repair a truncated JSON string by closing open strings, arrays, and objects.
 * Returns the original string if repair fails.
 */
export function repairTruncatedJson(text: string): string {
  try {
    JSON.parse(text);
    return text; // Already valid
  } catch {
    // Continue to repair
  }

  let repaired = text.trimEnd();

  // Remove trailing comma
  repaired = repaired.replace(/,\s*$/, "");

  // If we're inside a string (odd number of unescaped quotes), close it
  let inString = false;
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
      inString = !inString;
    }
  }
  if (inString) {
    // Trim back to last complete-ish value and close the string
    // Remove any partial escape sequence at the end
    repaired = repaired.replace(/\\$/, "");
    repaired += '"';
  }

  // Remove any trailing partial key-value pair (e.g. `,"partialKey` or `,"key":"partialVal"`)
  // after closing the string, try to trim back to last complete entry
  try {
    JSON.parse(repaired + "}".repeat(20) + "]".repeat(20));
  } catch {
    // Try removing the last key-value pair if it seems partial
    const lastComma = repaired.lastIndexOf(",");
    if (lastComma > 0) {
      const candidate = repaired.slice(0, lastComma);
      try {
        // Check if trimming to last comma gives us something closeable
        const stack: string[] = [];
        for (const ch of candidate) {
          if (ch === "{" || ch === "[") stack.push(ch);
          else if (ch === "}" || ch === "]") stack.pop();
        }
        if (stack.length >= 0) {
          repaired = candidate;
        }
      } catch {
        // Keep repaired as-is
      }
    }
  }

  // Balance brackets/braces
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i]!;
    if (ch === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  // Close open brackets in reverse order
  while (stack.length > 0) {
    const opener = stack.pop()!;
    repaired += opener === "{" ? "}" : "]";
  }

  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return text; // Unrepairable
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/investigation.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/agent/investigation.ts src/agent/investigation.test.ts
git commit -m "feat: add repairTruncatedJson utility for truncated LLM responses"
```

---

### Task 3: Wire JSON Repair into runPhase + Raise Token Limits

**Files:**
- Modify: `src/agent/investigation.ts:579,627,1265,1288,1291,1397`

**Step 1: Raise token limit constants**

In `src/agent/investigation.ts`, change:

```typescript
// Line ~579
const SYNTHESIS_MAX_TOKENS = 16384;
// Line ~627
const REFLECTION_MAX_TOKENS = 16384;
```

**Step 2: Wire `repairTruncatedJson` into `runPhase()` JSON parse paths**

In `runPhase()`, wrap the 3 `JSON.parse` calls with a repair fallback:

At line ~1265 (primary parse):
```typescript
try {
  return { parsed: JSON.parse(response.content) as T, images: phaseImages, toolData: phaseToolData };
} catch {
  const repaired = repairTruncatedJson(response.content);
  if (repaired !== response.content) {
    try {
      logger.info({ originalLen: response.content.length, repairedLen: repaired.length }, "Recovered truncated JSON via repair");
      return { parsed: JSON.parse(repaired) as T, images: phaseImages, toolData: phaseToolData };
    } catch { /* fall through to fresh retry */ }
  }
  // ... existing fresh retry logic below
```

At line ~1291 (fresh retry parse):
```typescript
if (retryResponse.type === "text") {
  try {
    return { parsed: JSON.parse(retryResponse.content) as T, images: phaseImages, toolData: phaseToolData };
  } catch {
    const repaired = repairTruncatedJson(retryResponse.content);
    if (repaired !== retryResponse.content) {
      try {
        return { parsed: JSON.parse(repaired) as T, images: phaseImages, toolData: phaseToolData };
      } catch { /* fall through */ }
    }
  }
}
```

At line ~1397 (post-loop fresh prompt):
```typescript
try {
  return { parsed: JSON.parse(retryResponse.content) as T, images: phaseImages, toolData: phaseToolData };
} catch {
  const repaired = repairTruncatedJson(retryResponse.content);
  if (repaired !== retryResponse.content) {
    try {
      return { parsed: JSON.parse(repaired) as T, images: phaseImages, toolData: phaseToolData };
    } catch (err) {
      logger.error({ err, contentLen: retryResponse.content.length, contentPreview: retryResponse.content.slice(0, 200) }, "Fresh prompt also failed to produce valid JSON");
    }
  }
}
```

Also raise the fresh-retry maxOutputTokens caps:

Line ~1288: `maxOutputTokens: maxOutputTokens ? Math.max(maxOutputTokens, 16384) : 16384`
Line ~1397: `maxOutputTokens: maxOutputTokens ? Math.max(maxOutputTokens, 16384) : 16384`

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/agent/investigation.ts
git commit -m "fix: raise synthesis token limits to 16384 and wire JSON repair into runPhase"
```

---

### Task 4: Root Cause Quality Gate

**Files:**
- Modify: `src/agent/investigation.ts` (in `investigate()`, between synthesis and reflection)
- Test: `src/agent/investigation.test.ts`

**Step 1: Write the failing test**

Add to `src/agent/investigation.test.ts`:

```typescript
it("retries synthesis when root cause is non-conclusive and evidence exists", async () => {
  const nonConclusiveReport = JSON.stringify({
    severity: "medium",
    summary: "Ingestion rate dropped",
    impact: { duration: "3 hours", description: "30% drop" },
    trigger: "Unknown",
    rootCause: "Not yet identified — pending further investigation",
    contributingFactors: [],
    timeline: [],
    evidence: { metrics: ["ingestion_rate dropped 30%"], logs: ["Kafka connection errors"], infra: [] },
    dashboardLinks: [],
    recommendedActions: ["Investigate Kafka"],
    confidence: "low",
  });
  const conclusiveReport = JSON.stringify({
    severity: "medium",
    summary: "Ingestion rate dropped due to Kafka failure",
    impact: { duration: "3 hours", description: "30% drop" },
    trigger: "Kafka broker restart",
    rootCause: "Kafka broker-5 restarted, causing producer connection failures and ingestion back-pressure",
    contributingFactors: ["No retry backoff configured"],
    timeline: [{ time: "14:30 UTC", event: "Kafka broker restart" }],
    evidence: { metrics: ["ingestion_rate dropped 30%"], logs: ["Kafka connection errors"], infra: [] },
    dashboardLinks: [],
    recommendedActions: ["Add retry backoff"],
    confidence: "medium",
  });

  // LLM calls: plan, metrics, logs, infra, synthesis(non-conclusive), synthesis(retry), reflection
  const llm = makeMockLlm([
    basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings,
    nonConclusiveReport, conclusiveReport, baseReflectionResponse,
  ]);
  const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

  const report = await agent.investigate(service, anomaly, "corr-quality");

  expect(report.rootCause).toContain("Kafka broker-5");
  // 7 calls: plan + 3 evidence + synthesis + synthesis retry + reflection
  expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(7);
});

it("keeps original synthesis when root cause is conclusive", async () => {
  // 6 LLM calls: plan, metrics, logs, infra, synthesis, reflection — no retry
  const llm = makeMockLlm([basePlanResponse, baseMetricFindings, baseLogFindings, baseInfraFindings, baseRcaReport, baseReflectionResponse]);
  const agent = new InvestigationAgent(llm, mockMcp, { maxIterations: 5 });

  const report = await agent.investigate(service, anomaly, "corr-no-retry");

  expect(report.rootCause).toBe("DB connection pool exhausted");
  expect((llm.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(6);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/investigation.test.ts`
Expected: First new test FAILS (no retry happening, gets non-conclusive root cause)

**Step 3: Implement quality gate**

In `src/agent/investigation.ts`, in `investigate()` method, after synthesis (around line ~614) and before the reflection section (line ~616), add:

```typescript
    // Root cause quality gate: retry synthesis if non-conclusive and evidence exists
    const nonConclusivePattern = /\b(not yet|pending|under investigation|to be determined|unable to determine|not identified|needs? further|cannot determine|inconclusive)\b/i;
    const hasEvidence = metricFindings.observations.length > 0 || logFindings.observations.length > 0 || infraFindings.observations.length > 0;
    if (nonConclusivePattern.test(synthesisResult.parsed.rootCause ?? "") && hasEvidence) {
      log.info({ rootCause: synthesisResult.parsed.rootCause?.slice(0, 80) }, "Non-conclusive root cause detected, retrying synthesis");
      const retryMessage = synthesisMessage + "\n\nIMPORTANT: Your previous response had a non-conclusive root cause. You MUST state your best-hypothesis root cause based on the evidence. If uncertain, state the most likely cause with explicit caveats (e.g. 'Most likely: X, pending confirmation of Y'). NEVER say 'pending' or 'not yet determined'.";
      try {
        const retryResult = await this.runPhase<SynthesisResult>(
          RCA_SYNTHESIS_PROMPT,
          retryMessage,
          RCA_REPORT_SCHEMA,
          3,
          onTokenUsage,
          onToolCall,
          false,
          SYNTHESIS_MAX_TOKENS,
          REASONING_TIMEOUT_MS,
        );
        if (!nonConclusivePattern.test(retryResult.parsed.rootCause ?? "")) {
          log.info({ rootCause: retryResult.parsed.rootCause?.slice(0, 80) }, "Synthesis retry produced conclusive root cause");
          synthesisResult = retryResult;
          collectedImages.push(...retryResult.images);
        }
      } catch (err) {
        log.warn({ err }, "Synthesis retry failed, keeping original");
      }
    }
```

Note: `synthesisResult` needs to be declared with `let` instead of `const` if not already. Check line ~597 — it's already `let synthesisResult`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/investigation.test.ts`
Expected: All tests PASS

**Step 5: Run full test suite + type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All PASS, no type errors

**Step 6: Commit**

```bash
git add src/agent/investigation.ts src/agent/investigation.test.ts
git commit -m "fix: add root cause quality gate with targeted synthesis retry"
```

---

### Task 5: Final Validation

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Run 10-run benchmark**

Run: `NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx dev/run-investigation.ts --runs 10 --service ingestion-server --message "investigate on the drop on ingestion rate on 2026-03-03" --force-anomaly`

Expected: 8-9/10 runs produce conclusive root causes with detailed evidence sections.

**Step 4: Compare results with baseline**

Review `dev/output/summary.json` and individual `dev/output/run-*/report.json` files. Check:
- Root cause is conclusive (not "pending"/"not yet identified") in 8+ runs
- Evidence sections have entries (metrics > 0, logs > 0) in 9+ runs
- No synthesis truncation errors in logs

**Step 5: Commit benchmark results if satisfactory**

```bash
git add docs/plans/2026-03-08-investigation-robustness-plan.md
git commit -m "docs: add investigation robustness implementation plan"
```

# Investigation Agent Robustness Design

**Date:** 2026-03-08
**Problem:** 10-run benchmark shows only 4/10 runs produce high-quality RCA reports. 6/10 suffer from empty evidence, truncated JSON, or non-conclusive root causes.
**Model:** gpt-oss-120b (self-hosted)
**Priority:** Reliability first — maximize "good" run rate even at higher token cost.

## Root Causes

### Issue 1: Empty content from hallucinated function calls
- Model emits `<|constrain|>json` as a function call with zero text content
- LLM client filters the hallucinated call, returns `{ type: "text", content: "" }`
- `JSON.parse("")` fails → evidence phase returns `{}`
- **Frequency:** 11 failures across 10 runs (every run affected)

### Issue 2: Synthesis/reflection JSON truncation at 8192 tokens
- RCA report JSON is 20-35k chars, exceeds 8192 max output tokens
- Truncated JSON fails to parse, retry also truncates
- **Frequency:** 6 truncation events across 10 runs

### Issue 3: Non-conclusive root cause ("pending", "not yet identified")
- When evidence phases return empty findings (cascading from Issue 1), synthesis lacks data
- Model produces "investigation guide" instead of conclusions
- **Frequency:** 4/10 runs (runs 1, 7, 8, 10)

## Fix 1: LLM Client Hallucination Retry

**File:** `src/llm/openai.ts` — `doChat()`

When hallucinated function calls are filtered AND `textContent` is empty:
1. Append nudge to input: `"Respond with valid JSON only. Do not call any functions."`
2. Re-call `responses.create()` (up to 2 retries)
3. If retry produces text → return normally
4. If still empty → return `{ type: "text", content: "" }` (unchanged fallback)

Not changed: when hallucinated calls are filtered but textContent is non-empty, behavior stays the same.

## Fix 2: Higher Synthesis Tokens + Truncated JSON Repair

**File:** `src/agent/investigation.ts`

**Token limits:**
- `SYNTHESIS_MAX_TOKENS`: 8192 → 16384
- `REFLECTION_MAX_TOKENS`: 8192 → 16384
- Fresh-prompt retry maxOutputTokens: 8192 → 16384

**JSON repair function:** `repairTruncatedJson(text: string): string`
1. Try `JSON.parse(text)` — if works, return as-is
2. Walk backwards: close open strings, trim partial key-value pairs, balance brackets/braces
3. Try `JSON.parse` on repaired string — if works, return it
4. If repair fails, return original (caller handles error)

Used in `runPhase()` as fallback when direct `JSON.parse` fails.

## Fix 3: Root Cause Quality Gate

**File:** `src/agent/investigation.ts` — `investigate()`, between synthesis and reflection

1. Check `rootCause` against non-conclusive patterns: `/\b(not yet|pending|under investigation|to be determined|unable to determine|not identified|needs? further|cannot determine|inconclusive)\b/i`
2. Check if meaningful evidence exists (any observations arrays non-empty)
3. If non-conclusive AND evidence exists → retry synthesis once with stronger prompt demanding a best-hypothesis conclusion
4. Use retry result if conclusive, otherwise keep original for reflection

## Expected Impact

- Fix 1 eliminates root cause of empty evidence → fewer cascade failures
- Fix 2 eliminates synthesis truncation → complete reports
- Fix 3 catches remaining non-conclusive outputs → actionable conclusions
- Target: 8-9/10 runs producing quality matching the current "best" run

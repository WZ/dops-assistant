# Incident History Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist slim incident records to disk after each investigation and inject recent history into the Phase 1.5 planning prompt so the LLM can detect recurring issues.

**Architecture:** New `src/history/store.ts` module handles file I/O (save, read, prune). The `InvestigationAgent` calls `getRecentIncidents()` before Phase 1.5 and `saveIncident()` after producing the report. `INVESTIGATION_PLAN_PROMPT` gains one sentence about recurrence.

**Tech Stack:** Node.js `fs/promises`, `path`, `glob` (via fast-glob or Node 22 `fs.glob`). Vitest for tests.

**Spec:** `docs/plans/2026-03-09-incident-history-design.md`

---

## Task 1: Incident history store — types and save

**Files:**
- Create: `src/history/store.ts`
- Create: `src/history/store.test.ts`

- [ ] **Step 1: Write the IncidentRecord type and saveIncident test**

In `src/history/store.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { saveIncident, getRecentIncidents } from "./store.js";
import type { IncidentRecord } from "./store.js";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("saveIncident", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "dops-test-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("writes a JSON file under incidents/{service}/", async () => {
    const record: IncidentRecord = {
      service: "api-gateway",
      severity: "high",
      summary: "5xx spike on api-gateway",
      rootCause: "OOM in upstream pod",
      trigger: "Memory leak after deploy v2.3",
      confidence: "high",
      investigatedAt: "2026-03-09T14:30:00Z",
    };
    await saveIncident(dir, record);
    const files = await readdir(path.join(dir, ".dops", "incidents", "api-gateway"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    const content = JSON.parse(await readFile(path.join(dir, ".dops", "incidents", "api-gateway", files[0]!), "utf-8"));
    expect(content.rootCause).toBe("OOM in upstream pod");
  });

  it("skips saving when severity is low", async () => {
    const record: IncidentRecord = {
      service: "api-gateway",
      severity: "low",
      summary: "No anomaly",
      rootCause: "No anomaly detected",
      trigger: "N/A",
      confidence: "high",
      investigatedAt: "2026-03-09T14:30:00Z",
    };
    await saveIncident(dir, record);
    const exists = await readdir(path.join(dir, ".dops", "incidents", "api-gateway")).catch(() => null);
    expect(exists).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/history/store.test.ts`
Expected: FAIL — module `./store.js` not found

- [ ] **Step 3: Implement saveIncident**

In `src/history/store.ts`:

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type IncidentRecord = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  rootCause: string;
  trigger: string;
  confidence: "low" | "medium" | "high";
  investigatedAt: string;
};

/** Directory for a service's incident files. */
function incidentDir(projectRoot: string, service: string): string {
  return path.join(projectRoot, ".dops", "incidents", service);
}

/** Convert an ISO date to a filename-safe string: 2026-03-09T14-30-00Z.json */
function toFilename(isoDate: string): string {
  return isoDate.replace(/:/g, "-").replace(/\.\d+/, "") + ".json";
}

/**
 * Save a slim incident record to disk.
 * Skips low-severity (no-anomaly) results.
 */
export async function saveIncident(projectRoot: string, record: IncidentRecord): Promise<void> {
  if (record.severity === "low") return;
  const dir = incidentDir(projectRoot, record.service);
  await mkdir(dir, { recursive: true });
  const filename = toFilename(record.investigatedAt);
  await writeFile(path.join(dir, filename), JSON.stringify(record, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/history/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/history/store.ts src/history/store.test.ts
git commit -m "feat(history): add IncidentRecord type and saveIncident"
```

---

## Task 2: Read recent incidents

**Files:**
- Modify: `src/history/store.ts`
- Modify: `src/history/store.test.ts`

- [ ] **Step 1: Write test for getRecentIncidents**

Append to `src/history/store.test.ts`:

```typescript
describe("getRecentIncidents", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "dops-test-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns recent incidents sorted by recency (newest first)", async () => {
    const base: Omit<IncidentRecord, "investigatedAt" | "summary"> = {
      service: "api-gateway", severity: "high", rootCause: "OOM", trigger: "deploy", confidence: "high",
    };
    await saveIncident(dir, { ...base, summary: "old", investigatedAt: "2026-03-01T10:00:00Z" });
    await saveIncident(dir, { ...base, summary: "newest", investigatedAt: "2026-03-09T10:00:00Z" });
    await saveIncident(dir, { ...base, summary: "middle", investigatedAt: "2026-03-05T10:00:00Z" });

    const results = await getRecentIncidents(dir, "api-gateway");
    expect(results).toHaveLength(3);
    expect(results[0]!.summary).toBe("newest");
    expect(results[2]!.summary).toBe("old");
  });

  it("returns at most 5 incidents", async () => {
    const base: Omit<IncidentRecord, "investigatedAt" | "summary"> = {
      service: "api-gateway", severity: "high", rootCause: "OOM", trigger: "deploy", confidence: "high",
    };
    for (let i = 0; i < 8; i++) {
      await saveIncident(dir, { ...base, summary: `incident-${i}`, investigatedAt: `2026-03-0${i + 1}T10:00:00Z` });
    }
    const results = await getRecentIncidents(dir, "api-gateway");
    expect(results).toHaveLength(5);
    expect(results[0]!.summary).toBe("incident-7"); // most recent
  });

  it("returns empty array when no incidents exist", async () => {
    const results = await getRecentIncidents(dir, "nonexistent-service");
    expect(results).toEqual([]);
  });

  it("skips corrupted JSON files gracefully", async () => {
    const base: Omit<IncidentRecord, "investigatedAt" | "summary"> = {
      service: "api-gateway", severity: "high", rootCause: "OOM", trigger: "deploy", confidence: "high",
    };
    await saveIncident(dir, { ...base, summary: "valid", investigatedAt: new Date().toISOString() });
    // Write a corrupted file directly
    const corruptDir = path.join(dir, ".dops", "incidents", "api-gateway");
    await writeFile(path.join(corruptDir, "corrupted.json"), "not valid json{{{");

    const results = await getRecentIncidents(dir, "api-gateway");
    expect(results).toHaveLength(1);
    expect(results[0]!.summary).toBe("valid");
  });

  it("filters out incidents older than 30 days", async () => {
    const base: Omit<IncidentRecord, "investigatedAt" | "summary"> = {
      service: "api-gateway", severity: "high", rootCause: "OOM", trigger: "deploy", confidence: "high",
    };
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await saveIncident(dir, { ...base, summary: "old", investigatedAt: old });
    await saveIncident(dir, { ...base, summary: "recent", investigatedAt: recent });

    const results = await getRecentIncidents(dir, "api-gateway");
    expect(results).toHaveLength(1);
    expect(results[0]!.summary).toBe("recent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/history/store.test.ts`
Expected: FAIL — `getRecentIncidents` not implemented (or returns wrong results)

- [ ] **Step 3: Implement getRecentIncidents**

Add to `src/history/store.ts`:

```typescript
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";

const MAX_RETURN = 5;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Read recent incidents for a service.
 * Returns up to 5, sorted newest-first, filtered to last 30 days.
 */
export async function getRecentIncidents(projectRoot: string, service: string): Promise<IncidentRecord[]> {
  const dir = incidentDir(projectRoot, service);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // directory doesn't exist yet
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  const records: IncidentRecord[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(path.join(dir, file), "utf-8");
      const record = JSON.parse(content) as IncidentRecord;
      if (new Date(record.investigatedAt).getTime() >= cutoff) {
        records.push(record);
      }
    } catch {
      // skip corrupted files
    }
  }

  records.sort((a, b) => new Date(b.investigatedAt).getTime() - new Date(a.investigatedAt).getTime());
  return records.slice(0, MAX_RETURN);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/history/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/history/store.ts src/history/store.test.ts
git commit -m "feat(history): add getRecentIncidents with age filter and cap"
```

---

## Task 3: Pruning on write

**Files:**
- Modify: `src/history/store.ts`
- Modify: `src/history/store.test.ts`

- [ ] **Step 1: Write test for pruning**

Append to `src/history/store.test.ts`:

```typescript
describe("pruneIncidents", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "dops-test-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("deletes files older than 30 days on save", async () => {
    const base: Omit<IncidentRecord, "investigatedAt" | "summary"> = {
      service: "api-gateway", severity: "high", rootCause: "OOM", trigger: "deploy", confidence: "high",
    };
    // Write an old incident directly (bypassing the age check in save)
    const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const oldDir = path.join(dir, ".dops", "incidents", "api-gateway");
    await mkdir(oldDir, { recursive: true });
    await writeFile(path.join(oldDir, toFilename(oldDate)), JSON.stringify({ ...base, summary: "old", investigatedAt: oldDate }));

    // Save a new incident — should prune the old one
    await saveIncident(dir, { ...base, summary: "new", investigatedAt: new Date().toISOString() });

    const files = await readdir(oldDir);
    expect(files).toHaveLength(1);
    const content = JSON.parse(await readFile(path.join(oldDir, files[0]!), "utf-8"));
    expect(content.summary).toBe("new");
  });

  it("keeps at most 10 files per service", async () => {
    const base: Omit<IncidentRecord, "investigatedAt" | "summary"> = {
      service: "api-gateway", severity: "high", rootCause: "OOM", trigger: "deploy", confidence: "high",
    };
    // Write 12 incidents
    for (let i = 0; i < 12; i++) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString();
      await saveIncident(dir, { ...base, summary: `incident-${i}`, investigatedAt: date });
    }
    const files = await readdir(path.join(dir, ".dops", "incidents", "api-gateway"));
    expect(files.length).toBeLessThanOrEqual(10);
  });
});
```

Note: `toFilename` must be exported for this test. Add `export` to the function in `store.ts`. Also add `toFilename` to the import from `./store.js` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/history/store.test.ts`
Expected: FAIL — no pruning logic yet

- [ ] **Step 3: Implement pruning in saveIncident**

Update `saveIncident` in `src/history/store.ts` to call `pruneIncidents` after writing:

```typescript
import { mkdir, writeFile, readdir, readFile, unlink } from "node:fs/promises";

const MAX_FILES = 10;

/**
 * Delete incident files beyond age/count limits.
 */
export async function pruneIncidents(projectRoot: string, service: string): Promise<void> {
  const dir = incidentDir(projectRoot, service);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }

  // Parse dates from file content (more robust than filename parsing)
  const withDates: Array<{ file: string; date: Date }> = [];
  for (const f of files) {
    try {
      const content = await readFile(path.join(dir, f), "utf-8");
      const record = JSON.parse(content) as { investigatedAt: string };
      withDates.push({ file: f, date: new Date(record.investigatedAt) });
    } catch {
      // corrupted file — mark for deletion with epoch date
      withDates.push({ file: f, date: new Date(0) });
    }
  }
  withDates.sort((a, b) => a.date.getTime() - b.date.getTime());

  const cutoff = Date.now() - MAX_AGE_MS;
  const toDelete: string[] = [];

  for (const entry of withDates) {
    if (entry.date.getTime() < cutoff) {
      toDelete.push(entry.file);
    }
  }

  // Also enforce count cap — remove oldest beyond MAX_FILES
  const remaining = withDates.filter((e) => !toDelete.includes(e.file));
  if (remaining.length > MAX_FILES) {
    const excess = remaining.slice(0, remaining.length - MAX_FILES);
    toDelete.push(...excess.map((e) => e.file));
  }

  await Promise.all(toDelete.map((f) => unlink(path.join(dir, f))));
}

// Update saveIncident to call pruneIncidents:
export async function saveIncident(projectRoot: string, record: IncidentRecord): Promise<void> {
  if (record.severity === "low") return;
  const dir = incidentDir(projectRoot, record.service);
  await mkdir(dir, { recursive: true });
  const filename = toFilename(record.investigatedAt);
  await writeFile(path.join(dir, filename), JSON.stringify(record, null, 2));
  await pruneIncidents(projectRoot, record.service);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/history/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/history/store.ts src/history/store.test.ts
git commit -m "feat(history): add pruning on save (30-day age, 10-file cap)"
```

---

## Task 4: Format recent incidents for the planning prompt

**Files:**
- Modify: `src/history/store.ts`
- Modify: `src/history/store.test.ts`

- [ ] **Step 1: Write test for formatIncidentHistory**

Append to `src/history/store.test.ts`:

```typescript
import { formatIncidentHistory } from "./store.js";

describe("formatIncidentHistory", () => {
  it("formats incidents as prompt-ready text", () => {
    const now = new Date("2026-03-09T14:00:00Z");
    const records: IncidentRecord[] = [
      {
        service: "api-gateway", severity: "high",
        summary: "5xx spike on api-gateway",
        rootCause: "OOM in upstream pod", trigger: "deploy v2.3",
        confidence: "high", investigatedAt: "2026-03-06T14:00:00Z",
      },
      {
        service: "api-gateway", severity: "medium",
        summary: "Elevated latency",
        rootCause: "Connection pool exhaustion", trigger: "traffic spike",
        confidence: "medium", investigatedAt: "2026-03-01T10:00:00Z",
      },
    ];
    const result = formatIncidentHistory(records, now);
    expect(result).toContain("3 days ago");
    expect(result).toContain("[high]");
    expect(result).toContain("OOM in upstream pod");
    expect(result).toContain("8 days ago");
    expect(result).toContain("[medium]");
    expect(result).toContain("Connection pool exhaustion");
    expect(result).toContain("recurrence");
  });

  it("returns empty string when no incidents", () => {
    expect(formatIncidentHistory([])).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/history/store.test.ts`
Expected: FAIL — `formatIncidentHistory` not found

- [ ] **Step 3: Implement formatIncidentHistory**

Add to `src/history/store.ts`:

```typescript
/**
 * Format incident records as a text block for the planning prompt.
 * Returns empty string if no records.
 */
export function formatIncidentHistory(records: IncidentRecord[], now = new Date()): string {
  if (records.length === 0) return "";

  const lines = records.map((r) => {
    const daysAgo = Math.round((now.getTime() - new Date(r.investigatedAt).getTime()) / (24 * 60 * 60 * 1000));
    const age = daysAgo === 0 ? "today" : daysAgo === 1 ? "1 day ago" : `${daysAgo} days ago`;
    return `- ${age} [${r.severity}] ${r.summary} (root cause: ${r.rootCause})`;
  });

  return [
    "Recent incidents for this service (last 30 days):",
    ...lines,
    "",
    "Consider whether the current anomaly is a recurrence or related to a previous root cause.",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/history/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/history/store.ts src/history/store.test.ts
git commit -m "feat(history): add formatIncidentHistory for planning prompt injection"
```

---

## Task 5: Wire into InvestigationAgent

**Files:**
- Modify: `src/agent/investigation.ts` (lines ~449-459, ~815-820)
- Modify: `src/agent/rca-prompts.ts` (line ~104)
- Modify: `src/agent/investigation.test.ts`

- [ ] **Step 1: Update INVESTIGATION_PLAN_PROMPT**

In `src/agent/rca-prompts.ts`, change the `INVESTIGATION_PLAN_PROMPT` (line 104) to:

```typescript
export const INVESTIGATION_PLAN_PROMPT = `Based on the detected anomaly, create a focused investigation plan.
Determine what specific metrics, logs, and infrastructure checks will be most relevant.
Consider: What are the most likely root causes? What evidence would confirm or rule out each?
If recent incidents are provided, consider whether the current anomaly is a recurrence or shares a root cause with a previous incident.

Respond ONLY with valid JSON matching the required schema.`;
```

- [ ] **Step 2: Add projectRoot to InvestigationAgent constructor**

In `src/agent/investigation.ts`, the constructor currently takes `llm`, `mcp`, `opts`. Add an optional `projectRoot` parameter:

```typescript
// Add import at top:
import { getRecentIncidents, saveIncident, formatIncidentHistory } from "../history/store.js";

// Update constructor (line ~375):
private projectRoot?: string;

constructor(llm: LlmClient, mcp: MultiMcpClient, opts: { maxIterations: number; projectRoot?: string }) {
  this.llm = llm;
  this.mcp = mcp;
  this.maxIterations = opts.maxIterations;
  this.projectRoot = opts.projectRoot;
}
```

- [ ] **Step 3: Inject history into Phase 1.5 planning message**

In `src/agent/investigation.ts`, before the `planMessage` construction (line ~452), fetch and format history:

```typescript
// Fetch recent incident history for planning context
let historyContext = "";
if (this.projectRoot) {
  try {
    const recentIncidents = await getRecentIncidents(this.projectRoot, service.name);
    historyContext = formatIncidentHistory(recentIncidents);
    if (historyContext) log.debug({ count: recentIncidents.length }, "Injecting incident history into planning");
  } catch (err) {
    log.warn({ err }, "Failed to read incident history");
  }
}
```

Then append to `planMessage`:

```typescript
const planMessage = [
  `Service: ${service.name}`,
  `Anomaly: ${anomaly.summary}`,
  `Severity: ${anomaly.severity}`,
  `Affected metrics: ${anomaly.affectedMetrics.join(", ")}`,
  `Service metrics: ${service.metrics.map((m) => `${m.description} (${m.query})`).join(", ") || "none configured"}`,
  `Log labels: ${JSON.stringify(service.logLabels)}`,
  historyContext ? `\n${historyContext}` : "",
].join("\n");
```

- [ ] **Step 4: Save incident after investigation completes**

At the end of `investigate()`, just before the return (line ~815), add:

```typescript
const finalReport: RcaReport = {
  ...report,
  service: service.name,
  investigatedAt: new Date().toISOString(),
  panelImages: collectedImages,
};

// Persist slim incident record for future investigations
if (this.projectRoot) {
  saveIncident(this.projectRoot, {
    service: finalReport.service,
    severity: finalReport.severity,
    summary: finalReport.summary,
    rootCause: finalReport.rootCause,
    trigger: finalReport.trigger,
    confidence: finalReport.confidence,
    investigatedAt: finalReport.investigatedAt,
  }).catch((err) => log.warn({ err }, "Failed to save incident record"));
}

return finalReport;
```

Note: use `.catch()` fire-and-forget — saving history should never block or fail the investigation.

Also note: `investigatedAt` changes from `new Date().toLocaleString()` to `new Date().toISOString()` so filenames and date parsing are consistent. **This is a user-visible change** — the CLI report timestamp changes from locale format (e.g., "3/9/2026, 2:30:00 PM") to ISO 8601 ("2026-03-09T14:30:00.000Z"). This is intentional — ISO 8601 is unambiguous and required for filename/date-parsing consistency.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: PASS — existing tests still work (they don't pass `projectRoot` so history is a no-op)

- [ ] **Step 6: Add test for history injection into planning**

Add to `src/agent/investigation.test.ts`:

```typescript
it("injects recent incident history into planning prompt", async () => {
  // Create a temp dir with a pre-existing incident
  const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const tmpDir = await mkdtemp(path.join(tmpdir(), "dops-test-"));

  try {
    const incDir = path.join(tmpDir, ".dops", "incidents", "test-service");
    await mkdir(incDir, { recursive: true });
    await writeFile(path.join(incDir, "2026-03-08T10-00-00Z.json"), JSON.stringify({
      service: "test-service", severity: "high", summary: "Previous OOM incident",
      rootCause: "Memory leak in v2.3", trigger: "deploy", confidence: "high",
      investigatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }));

    const agent = new InvestigationAgent(mockLlm, mockMcp, { maxIterations: 20, projectRoot: tmpDir });
    await agent.investigate(service, anomaly, "corr-history");

    // Planning is call index 0 (plan, metrics, logs, infra, synthesis, reflection)
    const planCall = chatCalls[0]!;
    const planUserMsg = planCall[0][1].content as string;
    expect(planUserMsg).toContain("Recent incidents");
    expect(planUserMsg).toContain("Previous OOM incident");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/agent/investigation.ts src/agent/rca-prompts.ts src/agent/investigation.test.ts
git commit -m "feat(history): wire incident history into investigation pipeline"
```

---

## Task 6: Wire projectRoot from CLI + add .dops to .gitignore

**Files:**
- Modify: `src/cli.tsx` (line ~72)
- Modify: `src/index.ts` (line ~49)
- Modify: `.gitignore`

- [ ] **Step 1: Update InvestigationAgent construction in src/cli.tsx**

In `src/cli.tsx` line ~72, add `projectRoot`:

```typescript
const investigationAgent = new InvestigationAgent(llm, mcp, {
  maxIterations: config.agent.maxIterations,
  projectRoot: process.cwd(),
});
```

- [ ] **Step 2: Update InvestigationAgent construction in src/index.ts**

In `src/index.ts` line ~49, add `projectRoot`:

```typescript
const investigationAgent = new InvestigationAgent(llm, mcp, {
  maxIterations: config.agent.maxIterations,
  projectRoot: process.cwd(),
});
```

- [ ] **Step 3: Add .dops/ to .gitignore**

Append to `.gitignore`:

```
# Local incident history
.dops/
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/cli.tsx src/index.ts .gitignore
git commit -m "feat(history): wire projectRoot from CLI, add .dops to gitignore"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Manual smoke test**

Run: `npm run cli`
Investigate a service, then check `.dops/incidents/{service}/` for a JSON file. Investigate the same service again and verify the planning phase log shows "Injecting incident history into planning".

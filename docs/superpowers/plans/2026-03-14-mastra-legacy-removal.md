# Mastra Legacy Removal Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the legacy code path (pre-Mastra) after validating the Mastra migration end-to-end.

**Architecture:** The Mastra refactor (PR #17) added a dual-path migration with `USE_MASTRA=true` toggle. This plan removes the legacy path, making Mastra the only code path.

**Tech Stack:** TypeScript ESM, Vitest, Mastra

**Prerequisite:** All validation tasks must pass before proceeding to removal tasks.

---

## Chunk 1: Validation

### Task 1: Validate Chat Streaming (Web)

**Files:** None modified — manual testing only

- [ ] **Step 1: Start web server with Mastra enabled**

Run:
```bash
USE_MASTRA=true npm run web
```
Expected: Server starts on port 3000

- [ ] **Step 2: Open browser, send a chat message**

Navigate to `http://localhost:3000`, send "what dashboards are available?"

Expected: Response streams in real-time, tool calls visible, response completes

- [ ] **Step 3: Verify tool calling works**

Send a message that requires MCP tools (e.g., "query CPU usage for the last hour")

Expected: Agent calls MCP tools, returns formatted response

---

### Task 2: Validate Chat Streaming (CLI)

- [ ] **Step 1: Start CLI with Mastra enabled**

Run:
```bash
USE_MASTRA=true npm run cli
```
Expected: CLI starts, prompt appears

- [ ] **Step 2: Send a chat message and verify streaming**

Expected: Response streams character-by-character in terminal

---

### Task 3: Validate Investigation Workflow

- [ ] **Step 1: Trigger investigation via web or CLI**

Run with `USE_MASTRA=true`, send: "investigate high latency on [service-name]"

Expected: Investigation workflow starts, phase events emitted to UI

- [ ] **Step 2: Verify all phases execute**

Expected:
- Prefetch context completes
- Anomaly detection runs
- Planning produces hypotheses
- Evidence gathering runs in parallel (metrics, logs, infra)
- Synthesis produces RcaReport with root cause, confidence, recommendations

- [ ] **Step 3: Verify degradation**

If one MCP provider is unavailable, the workflow should still complete with partial results.

---

### Task 4: Validate Conversation Memory

- [ ] **Step 1: Start a chat session, have a multi-turn conversation**

Send several messages in sequence. Verify the agent remembers context from earlier messages.

- [ ] **Step 2: Start a new session, verify working memory persists**

With LibSQL storage configured, restart the server and verify working memory (user role, known services) is retained.

---

## Chunk 2: Legacy Removal

> **Gate:** Do NOT start Chunk 2 until all 4 validation tasks pass.

### Task 5: Remove USE_MASTRA Toggle from Server

**Files:**
- Modify: `src/server/index.ts`
- Delete: `src/server/mastra-adapter.ts` (inline Mastra agents directly)

- [ ] **Step 1: Read `src/server/index.ts` and `src/server/mastra-adapter.ts`**

- [ ] **Step 2: Remove the `USE_MASTRA` conditional branch**

Make the Mastra path the only path. Remove the legacy `ChatAgent` and `InvestigationAgent` imports and instantiation.

- [ ] **Step 3: Inline Mastra agent creation**

Replace the adapter pattern with direct Mastra agent/workflow usage. The adapter was a migration bridge — no longer needed.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/server/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: remove USE_MASTRA toggle, make Mastra the default server path"
```

---

### Task 6: Remove USE_MASTRA Toggle from CLI

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/interfaces/cli/App.tsx` (if needed)

- [ ] **Step 1: Remove the `USE_MASTRA` conditional branch from `src/cli.tsx`**

- [ ] **Step 2: Update App.tsx if it still references legacy agent types**

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli.tsx src/interfaces/cli/App.tsx
git commit -m "feat: remove USE_MASTRA toggle, make Mastra the default CLI path"
```

---

### Task 7: Delete Deprecated Files

**Files:**
- Delete: `src/llm/openai.ts`
- Delete: `src/agent/core.ts`
- Delete: `src/agent/investigation.ts`
- Delete: `src/agent/types.ts`
- Delete: `src/agent/rca-types.ts` (re-export shim)
- Delete: `src/mcp/client.ts`
- Delete: `src/mcp/multi-client.ts`
- Delete: associated test files

- [ ] **Step 1: Verify no remaining imports of deprecated files**

Search for imports from each file. Fix any that still reference the old paths.

```bash
grep -r "from.*agent/core" src/ --include="*.ts" --include="*.tsx"
grep -r "from.*agent/investigation" src/ --include="*.ts" --include="*.tsx"
grep -r "from.*agent/types" src/ --include="*.ts" --include="*.tsx"
grep -r "from.*agent/rca-types" src/ --include="*.ts" --include="*.tsx"
grep -r "from.*llm/openai" src/ --include="*.ts" --include="*.tsx"
grep -r "from.*mcp/client" src/ --include="*.ts" --include="*.tsx"
grep -r "from.*mcp/multi-client" src/ --include="*.ts" --include="*.tsx"
```

- [ ] **Step 2: Update any remaining imports to new locations**

- `src/agent/rca-types.ts` → `src/types/rca-types.ts`
- Any other stale imports

- [ ] **Step 3: Delete deprecated files**

```bash
git rm src/llm/openai.ts src/agent/core.ts src/agent/investigation.ts src/agent/types.ts src/agent/rca-types.ts src/mcp/client.ts src/mcp/multi-client.ts
```

- [ ] **Step 4: Delete deprecated test files**

```bash
git rm src/agent/core.test.ts src/agent/investigation.test.ts src/mcp/client.test.ts src/mcp/multi-client.test.ts src/llm/openai.test.ts
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: PASS (test count will drop since old tests are removed)

- [ ] **Step 6: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json
git commit -m "cleanup: remove deprecated pre-Mastra files (openai.ts, ChatAgent, InvestigationAgent, MCP client)"
```

---

### Task 8: Uninstall Legacy Dependencies

- [ ] **Step 1: Remove openai package**

```bash
npm uninstall openai
```

- [ ] **Step 2: Check for other unused dependencies**

Review `package.json` for packages only used by the deleted files (e.g., `@modelcontextprotocol/sdk` if fully replaced by `@mastra/mcp`).

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "cleanup: uninstall openai and unused legacy dependencies"
```

---

### Task 9: Delete Mastra Adapter (Now Unnecessary)

**Files:**
- Delete: `src/server/mastra-adapter.ts`

- [ ] **Step 1: Verify mastra-adapter.ts is no longer imported**

- [ ] **Step 2: Delete it**

```bash
git rm src/server/mastra-adapter.ts
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git commit -m "cleanup: remove mastra-adapter bridge (no longer needed)"
```

---

### Task 10: Final CLAUDE.md Update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove "deprecated" labels from architecture section**

The Mastra path is now the only path. Remove references to legacy code and USE_MASTRA flag.

- [ ] **Step 2: Update Architecture section**

```markdown
## Architecture

- **LLM client**: Mastra model abstraction via `@ai-sdk/openai-compatible`
- **Chat agent**: `src/agents/chat.ts` — Mastra Agent with MCP tools
- **Investigation**: `src/workflows/investigation.ts` — Mastra workflow with parallel evidence gathering
- **Agents**: `src/agents/` — 7 specialized agents (anomaly detector, planner, metrics, logs, infra, synthesis, chat)
- **MCP**: `src/mcp/provider.ts` — role-based tool routing via `@mastra/mcp`
- **Memory**: `src/mastra/memory.ts` — thread-based conversation history + working memory
- **CLI**: `src/cli.tsx` + `src/interfaces/cli/App.tsx` — Ink React terminal UI
```

- [ ] **Step 3: Remove legacy Investigation Agent Patterns section**

Replace with Mastra workflow patterns only.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: finalize CLAUDE.md for post-migration architecture"
```

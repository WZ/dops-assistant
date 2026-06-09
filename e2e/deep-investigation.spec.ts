import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

/**
 * Deep Investigation — Console flow E2E.
 *
 * Seeds a completed investigation, opens it, clicks the single "Investigate
 * deeply" entry → "Full deep investigation", waits out the confirm-dispatch
 * countdown, and asserts the run streams INLINE in the Console: a live move, the
 * operator-pause prompt, then (after clicking continue) a confirmed result.
 *
 * The run is driven by the deterministic server stub (DEEP_INVESTIGATION_E2E_STUB=1
 * in playwright.config webServer) — no real LLM/MCP. Skips gracefully if the
 * feature flags aren't injected or the seed can't persist, mirroring the other
 * specs so environments without the fixture config still pass.
 */
const DB_PATH = path.resolve(process.cwd(), "dops.sqlite");
const INV_ID = "e2e-deep-investigation";

const REPORT = JSON.stringify({
  summary: "Prometheus scrape unreachable for impala.",
  rootCause: "Prometheus scrape target for impala is misconfigured or unreachable.",
  trigger: "scrape config drift",
  impact: { description: "metrics collection gap on impala" },
  confidenceScore: 0.9,
  severity: "medium",
  loopOutcome: "ruled-out",
  hypotheses: [],
  recommendedActions: [],
  contributingFactors: [],
  ruledOut: [],
  dashboardLinks: [],
  timeline: [],
  skillsUsed: [],
});

let stackId: string | null = null;
let seeded = false;

test.beforeAll(() => {
  try {
    const db = new Database(DB_PATH);
    const stack = db.prepare("SELECT id FROM stacks ORDER BY id ASC LIMIT 1").get() as { id: string } | undefined;
    stackId = stack?.id ?? null;
    if (stackId) {
      db.prepare(
        "INSERT OR REPLACE INTO investigations (id, stack_id, service, query, status, report, completed_at) VALUES (?, ?, 'impala', 'why is impala down', 'complete', ?, datetime('now'))",
      ).run(INV_ID, stackId, REPORT);
      seeded = true;
    }
    db.close();
  } catch {
    seeded = false;
  }
});

test.afterAll(() => {
  if (!seeded) return;
  try {
    const db = new Database(DB_PATH);
    db.prepare("DELETE FROM investigation_events WHERE investigation_id = ?").run(INV_ID);
    db.prepare("DELETE FROM investigation_phases WHERE investigation_id = ?").run(INV_ID);
    db.prepare("DELETE FROM investigations WHERE id = ?").run(INV_ID);
    db.close();
  } catch { /* best-effort cleanup */ }
});

test("deep investigation: report → Investigate deeply → Full → streams → pause → continue → confirmed", async ({ page }) => {
  test.skip(!seeded || !stackId, "Could not seed a completed investigation (stacks table empty?) — skipping.");

  await page.goto(`/stacks/${stackId}/investigations/${INV_ID}`);

  // The RCA report renders.
  await expect(page.getByText(/Root Cause/i).first()).toBeVisible({ timeout: 15_000 });

  // The single "Investigate deeply" entry. If the flags aren't injected in this
  // environment, the button won't exist — skip gracefully.
  const entry = page.getByRole("button", { name: /Investigate deeply/i });
  if ((await entry.count()) === 0) {
    test.skip(true, "Deep Investigation flag not enabled in this environment.");
    return;
  }
  await entry.click();

  // Pick the Full scope from the scoped menu.
  await page.getByRole("menuitem", { name: /Full deep investigation/i }).click();

  // Confirm-dispatch countdown, then the run starts and streams in the Console.
  // The fixture config intentionally has no service dependency graph, so the
  // deterministic stub first emits a stable generic ruling-out step before it
  // confirms on the incident service itself.
  await expect(page.getByText(/Starting deep investigation/i)).toBeVisible();
  await expect(page.getByText(/memory exhaustion/i).first()).toBeVisible({ timeout: 15_000 });

  // The operator-pause prompt appears; steer it with "continue".
  await expect(page.getByText(/needs your call/i).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /continue/i }).first().click();

  // The stubbed run confirms a root cause — the result-first conclusion shows.
  await expect(page.getByText(/connection pool starvation/i).first()).toBeVisible({ timeout: 15_000 });
});

test("deep investigation: a mid-flight run survives a reload — reattaches LIVE and resumes (PR-2c)", async ({ page }) => {
  test.skip(!seeded || !stackId, "Could not seed a completed investigation (stacks table empty?) — skipping.");

  await page.goto(`/stacks/${stackId}/investigations/${INV_ID}`);
  await expect(page.getByText(/Root Cause/i).first()).toBeVisible({ timeout: 15_000 });

  const entry = page.getByRole("button", { name: /Investigate deeply/i });
  if ((await entry.count()) === 0) {
    test.skip(true, "Deep Investigation flag not enabled in this environment.");
    return;
  }
  await entry.click();
  await page.getByRole("menuitem", { name: /Full deep investigation/i }).click();

  // Let the run stream up to the operator-pause — it is now blocked server-side
  // awaiting a decision (live in the registry, no terminal event yet).
  await expect(page.getByText(/memory exhaustion/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/needs your call/i).first()).toBeVisible({ timeout: 15_000 });

  // Reload. The WS drops, but PR-2c keeps the run alive server-side (close just
  // detaches the sink). On cold load the pane subscribes; the server replays the
  // history and streams live, so the run REATTACHES — the pause prompt shows
  // again, and it is NOT shown as interrupted.
  await page.reload();
  await expect(page.getByText(/Root Cause/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/memory exhaustion/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/needs your call/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/can't be resumed here/i)).toHaveCount(0); // not interrupted — it's live

  // Continue the reattached, still-live run → it resumes and confirms a cause.
  await page.getByRole("button", { name: /continue/i }).first().click();
  await expect(page.getByText(/connection pool starvation/i).first()).toBeVisible({ timeout: 15_000 });
});

test("legacy deep panel link redirects to the plain investigation pane", async ({ page }) => {
  test.skip(!seeded || !stackId, "Could not seed a completed investigation (stacks table empty?) — skipping.");

  // Direct hit on the removed PR-2d route should gracefully open the normal
  // investigation pane where the Console hosts any deep run.
  await page.goto(`/stacks/${stackId}/investigations/${INV_ID}/deep`);

  await expect(page.getByText(/Root Cause/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: /Deep Investigation/ })).toHaveCount(0);
});

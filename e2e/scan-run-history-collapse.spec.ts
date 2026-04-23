import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "path";

/**
 * History collapse E2E.
 *
 * Seeds the DB directly with 5 clean cron runs + 1 hits run, navigates to
 * the Ops Desk, and asserts the collapsed group and the hits row both render.
 *
 * This test bypasses the real scheduler entirely -- it's testing the UI's
 * collapse logic end-to-end against a known DB state. Skips when no stacks
 * are present. Cleans up seeded rows in a best-effort finally-style block.
 */

const DB_PATH = path.resolve(process.cwd(), "dops.sqlite");

test("history collapse: N consecutive clean cron ticks render as a single group", async ({ page }) => {
  const db = new Database(DB_PATH);
  const now = Date.now();
  const stackRow = db.prepare("SELECT id FROM stacks ORDER BY id ASC LIMIT 1").get() as { id: string } | undefined;
  if (!stackRow) {
    db.close();
    test.skip(true, "No stacks present in DB; run initial setup first.");
    return;
  }
  const stackId = stackRow.id;

  // Insert 5 clean cron runs (oldest -> newest consecutive).
  const insert = db.prepare(`
    INSERT INTO scan_runs (id, stack_id, trigger, status, started_at, finished_at, services_probed, hits_dispatched)
    VALUES (?, ?, 'cron', 'complete', ?, ?, 100, 0)
  `);
  const runIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = `e2e-clean-${Date.now()}-${i}`;
    runIds.push(id);
    insert.run(id, stackId, now - (i + 2) * 1000, now - (i + 2) * 1000 + 100);
  }
  // Insert 1 hits run (newest, with hits dispatched so it doesn't collapse).
  const hitsId = `e2e-hits-${Date.now()}`;
  db.prepare(`
    INSERT INTO scan_runs (id, stack_id, trigger, status, started_at, finished_at, services_probed, hits_dispatched)
    VALUES (?, ?, 'cron', 'complete', ?, ?, 100, 3)
  `).run(hitsId, stackId, now - 1000, now - 900);
  db.close();

  await page.goto("/");

  // The collapsed-group row shows "N clean cron ticks"
  await expect(page.getByText(/clean cron ticks/i)).toBeVisible({ timeout: 10_000 });

  // The hits row shows "3 hits"
  await expect(page.getByText(/3 hits/)).toBeVisible();

  // Cleanup
  const cleanup = new Database(DB_PATH);
  const all = [...runIds, hitsId];
  const deleteStmt = cleanup.prepare("DELETE FROM scan_runs WHERE id = ?");
  for (const id of all) deleteStmt.run(id);
  cleanup.close();
});

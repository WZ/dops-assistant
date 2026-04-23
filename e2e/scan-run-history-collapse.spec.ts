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

  // Clear prior residue before seeding. Two sources of residue:
  //  - e2e-* rows from earlier runs of this test that failed/timed out
  //    before reaching the cleanup block below.
  //  - real scan_runs for this stack from the server's cron scheduler that
  //    could merge into our seeded group and make the "N clean cron ticks"
  //    row contain a different N than we expected.
  // Destructive but scoped: only scan_runs for the default stack, not
  // investigations or other tables. The test owns this stack's scan
  // history for the duration of the run.
  db.prepare("DELETE FROM scan_run_investigations WHERE scan_run_id IN (SELECT id FROM scan_runs WHERE stack_id = ?)").run(stackId);
  db.prepare("DELETE FROM scan_runs WHERE stack_id = ?").run(stackId);

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

  // The collapsed-group row shows "5 clean cron ticks" — scoped to the
  // exact count we seeded, not a generic /clean cron ticks/i which would
  // strict-mode-fail if anything else on the page also collapsed. The
  // pre-seed wipe above guarantees this is the only collapse group.
  await expect(page.getByText(/5 clean cron ticks/)).toBeVisible({ timeout: 10_000 });

  // The hits row shows "3 hits"
  await expect(page.getByText(/3 hits/)).toBeVisible();

  // Cleanup
  const cleanup = new Database(DB_PATH);
  const all = [...runIds, hitsId];
  const deleteStmt = cleanup.prepare("DELETE FROM scan_runs WHERE id = ?");
  for (const id of all) deleteStmt.run(id);
  cleanup.close();
});

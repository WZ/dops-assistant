import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "path";

/**
 * Cross-stack isolation E2E for scan runs.
 *
 * Seeds a scan_run for a secondary stack, then navigates to the Ops Desk
 * (which defaults to the primary stack) and asserts that run is NOT visible.
 *
 * Requires at least 2 stacks in the DB. Skips if only 1. Cleans up seeded
 * row after assertions.
 */

const DB_PATH = path.resolve(process.cwd(), "dops.sqlite");

test("cross-stack isolation: scan runs from another stack are not visible", async ({ page }) => {
  const db = new Database(DB_PATH);
  const stacks = db.prepare("SELECT id FROM stacks ORDER BY id ASC LIMIT 2").all() as Array<{ id: string }>;
  if (stacks.length < 2) {
    db.close();
    test.skip(true, "Need at least 2 stacks; found " + stacks.length + ".");
    return;
  }
  const secondaryStackId = stacks[1]!.id;
  const runId = `e2e-other-stack-${Date.now()}`;
  db.prepare(`
    INSERT INTO scan_runs (id, stack_id, trigger, status, started_at, hits_dispatched)
    VALUES (?, ?, 'manual', 'complete', ?, 99)
  `).run(runId, secondaryStackId, Date.now());
  db.close();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Recent Scans/i })).toBeVisible();

  // The seeded run should NOT appear in the desk (it's on the other stack).
  // We can't assert "not visible" on content we never expect -- instead, confirm the
  // Recent Scans list doesn't contain a row with "99 hits".
  await expect(page.getByText(/99 hits/)).toHaveCount(0);

  // Cleanup
  const cleanup = new Database(DB_PATH);
  cleanup.prepare("DELETE FROM scan_runs WHERE id = ?").run(runId);
  cleanup.close();
});

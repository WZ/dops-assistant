import { test, expect } from "@playwright/test";

/**
 * Scan-run happy path E2E.
 *
 * Clicks "Scan now" on the Ops Desk, asserts navigation to /scan/runs/:id, the
 * phase stepper (Probe -> Triage -> Investigate), a terminal status, and that
 * the run appears in Recent Scans after returning to the desk.
 *
 * Skipped gracefully when scan is disabled in Settings, since the button is
 * disabled in that case. Terminal status assertion is permissive (complete |
 * skipped | failed) so environments without a live Prometheus provider still
 * transition the run to a deterministic end-state.
 */
test.describe.configure({ mode: "serial" });

test("scan run happy path: click Scan now -> navigate to detail -> see in history", async ({ page }) => {
  await page.goto("/");

  // Wait for Recent Scans section to render.
  const recentScans = page.getByRole("heading", { name: /Recent Scans/i });
  await expect(recentScans).toBeVisible();

  // If scan is disabled, the button is disabled -- skip the happy-path flow gracefully.
  const scanButton = page.getByRole("button", { name: /Scan now/i });
  if (await scanButton.isDisabled()) {
    test.skip(true, "Scan is disabled in this environment; enable in Settings to run this test.");
    return;
  }

  await scanButton.click();

  // After click: navigate to /scan/runs/:id
  await page.waitForURL(/\/scan\/runs\//, { timeout: 10_000 });

  // The phase stepper should appear with all three phases labeled.
  await expect(page.getByText(/probe/i)).toBeVisible();
  await expect(page.getByText(/triage/i)).toBeVisible();
  await expect(page.getByText(/investigate/i)).toBeVisible();

  // Wait for the run to terminate (status becomes "complete" / "skipped" / "failed").
  // We don't assert on specific phase outcomes since the provider may be unavailable.
  await expect(page.getByText(/complete|skipped|failed/i)).toBeVisible({ timeout: 30_000 });

  // Navigate back to the desk and verify the run shows up in Recent Scans.
  await page.goBack();
  // Look for ANY row referencing the manual trigger (generous matcher since the history row format
  // includes `manual · <N> probed · <M> hits`).
  await expect(page.getByText(/manual/)).toBeVisible({ timeout: 5_000 });
});

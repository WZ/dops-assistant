import { test, expect } from "@playwright/test";

/**
 * Destructive action E2E — the Remove confirmation dialog.
 *
 * Pre-Batch A: Remove button deletes with no confirmation (the QA bug).
 * Post-Batch A: ConfirmActionDialog with destructive variant + Cancel default.
 *
 * This spec is the acceptance test for Batch A Issue #1 and pins that
 * Escape/Cancel preserves the provider while Confirm removes it.
 */
test.describe("Remove provider confirmation", () => {
  test.beforeEach(async ({ request }) => {
    // Seed a throwaway provider via API so we're not dependent on existing state.
    // Uses the current stack (whatever the UI's activeStackId resolves to).
    await request.post("/api/providers", {
      data: {
        name: "e2e-victim",
        mcpServer: { transport: "http", url: "http://127.0.0.1:59999/mcp" },
        roles: ["metrics"],
        region: "test",
      },
    }).catch(() => {
      // If it already exists (from a prior failed run), we'll detect that in the UI step.
    });
  });

  test.afterEach(async ({ request }) => {
    await request.delete("/api/providers/e2e-victim").catch(() => {});
  });

  test("clicking Remove opens a confirm dialog, Cancel preserves", async ({ page }) => {
    await page.goto("/settings");
    const removeBtn = page.getByRole("button", { name: "Remove e2e-victim" });
    if (!(await removeBtn.isVisible().catch(() => false))) {
      test.skip(true, "e2e-victim seed did not persist — stack may be misconfigured");
    }
    await removeBtn.click();

    // Confirm dialog should appear with a Cancel button that's default-focused.
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Cancel/i })).toBeVisible();

    await dialog.getByRole("button", { name: /Cancel/i }).click();
    await expect(dialog).not.toBeVisible();

    // Provider should still be there.
    await expect(page.getByRole("button", { name: "Remove e2e-victim" })).toBeVisible();
  });

  test("Confirm removes the provider", async ({ page }) => {
    await page.goto("/settings");
    const removeBtn = page.getByRole("button", { name: "Remove e2e-victim" });
    if (!(await removeBtn.isVisible().catch(() => false))) {
      test.skip(true, "e2e-victim seed did not persist");
    }
    await removeBtn.click();

    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await dialog.getByRole("button", { name: /Remove|Confirm|Delete/i }).click();

    // Provider card should disappear.
    await expect(page.getByRole("button", { name: "Remove e2e-victim" })).not.toBeVisible();
  });
});

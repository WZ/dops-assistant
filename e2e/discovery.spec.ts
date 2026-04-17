import { test, expect } from "@playwright/test";

/**
 * Discovery UI surface E2E.
 *
 * This spec does NOT drive a real MCP discovery run (that requires live
 * endpoints). It pins the UI plumbing:
 *   - Run Discovery button exists on the Services empty state
 *   - Clicking it navigates to the discovery progress view
 *   - Progress UI renders phase tabs (Discovery / Validation / Review)
 *
 * Batch C may add a terminal-emit regression test here once the fix lands.
 */
test.describe("Discovery UI plumbing", () => {
  test("Services empty state shows Run Discovery CTA", async ({ page, request }) => {
    // Find a stack with 0 services to drive the empty state.
    const stacks = await request.get("/api/stacks").then((r) => r.json() as Promise<Array<{ id: string; healthSummary?: { total: number } }>>);
    const emptyStack = stacks.find((s) => (s.healthSummary?.total ?? 0) === 0);
    if (!emptyStack) {
      test.skip(true, "no stack with 0 services available to exercise empty state");
    }
    // localStorage is cross-origin on about:blank — must goto a real page first.
    await page.goto("/");
    await page.evaluate((id) => localStorage.setItem("dops:lastStackId", id), emptyStack!.id);
    await page.goto("/services");

    const runBtn = page.getByRole("button", { name: "Run Discovery" });
    await expect(runBtn).toBeVisible();
  });

  test.fixme("clicking Run Discovery surfaces phase tabs", async ({ page, request }) => {
    // Needs live MCP providers to reach the phase-tab render. CI fixture has
    // none. Batch C re-enables this with a proper mock or a dedicated
    // discovery-agent stub.
    const stacks = await request.get("/api/stacks").then((r) => r.json() as Promise<Array<{ id: string; healthSummary?: { total: number } }>>);
    const emptyStack = stacks.find((s) => (s.healthSummary?.total ?? 0) === 0);
    if (!emptyStack) test.skip(true, "no empty stack");

    // localStorage is cross-origin on about:blank — must goto a real page first.
    await page.goto("/");
    await page.evaluate((id) => localStorage.setItem("dops:lastStackId", id), emptyStack!.id);
    await page.goto("/services");
    await page.getByRole("button", { name: "Run Discovery" }).click();

    // Progress UI should appear within a few seconds.
    await expect(page.getByText(/Discovery/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Validation/i).first()).toBeVisible();
    await expect(page.getByText(/Review/i).first()).toBeVisible();
  });
});

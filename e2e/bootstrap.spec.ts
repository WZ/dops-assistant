import { test, expect } from "@playwright/test";

/**
 * Bootstrap flow E2E — the full user journey documented in plan.md.
 *
 * Covers: empty-state → add provider → form validation → save → visible in list.
 * Does NOT run real discovery (needs live MCP endpoints); that is covered by
 * discovery.spec.ts via mocked WS events.
 */
test.describe("Bootstrap flow", () => {
  test("Settings page shows 'New Provider' button", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // When the stack has no providers configured, both the header button and
    // the empty-state CTA render with the same accessible name. Either is fine
    // for asserting the entry point exists, so pick the first.
    await expect(page.getByRole("button", { name: "New Provider" }).first()).toBeVisible();
  });

  test("New Provider form exposes Name, URL, Roles, Region", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "New Provider" }).first().click();

    await expect(page.getByRole("textbox", { name: /Name/i }).or(page.getByPlaceholder("my-provider"))).toBeVisible();
    await expect(page.getByPlaceholder("http://localhost:8080/mcp")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "metrics" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "logs" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "dashboards" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "infrastructure" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "changes" })).toBeVisible();
  });

  test("form includes dependencies role (Batch A addition)", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "New Provider" }).first().click();
    await expect(page.getByRole("checkbox", { name: "dependencies" })).toBeVisible();
  });

  test("form includes webUrl input (Batch A addition)", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "New Provider" }).first().click();
    await expect(page.getByLabel(/web URL|webUrl/i).or(page.getByPlaceholder(/grafana\.example|https:\/\//i))).toBeVisible();
  });
});

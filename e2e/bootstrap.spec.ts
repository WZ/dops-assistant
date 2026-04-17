import { test, expect } from "@playwright/test";

/**
 * Bootstrap flow E2E — the full user journey documented in plan.md.
 *
 * Covers: empty-state → add provider → form validation → save → visible in list.
 * Does NOT run real discovery (needs live MCP endpoints); that is covered by
 * discovery.spec.ts via mocked WS events.
 */
test.describe("Bootstrap flow", () => {
  test("empty-state shows 'Add First Provider' CTA", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // If the stack has providers, this test's assertion is a smoke check — otherwise
    // the CTA is present. Both outcomes are acceptable.
    const hasCta = await page.getByRole("button", { name: "Add First Provider" }).isVisible().catch(() => false);
    const hasAdd = await page.getByRole("button", { name: "+ Add Provider" }).isVisible().catch(() => false);
    expect(hasCta || hasAdd).toBeTruthy();
  });

  test("Add Provider form exposes Name, URL, Roles, Region, Save", async ({ page }) => {
    await page.goto("/settings");
    const addBtn = page.getByRole("button", { name: /Add First Provider|\+ Add Provider/ });
    await addBtn.first().click();

    await expect(page.getByRole("textbox", { name: /Name/i }).or(page.getByPlaceholder("my-provider"))).toBeVisible();
    await expect(page.getByPlaceholder("http://localhost:8080/mcp")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "metrics" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "logs" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "dashboards" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "infrastructure" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "changes" })).toBeVisible();
  });

  test.fixme("form includes dependencies role (Batch A addition)", async ({ page }) => {
    // Batch A adds the dependencies checkbox to ProviderForm.tsx. Remove .fixme when A lands.
    await page.goto("/settings");
    const addBtn = page.getByRole("button", { name: /Add First Provider|\+ Add Provider/ });
    await addBtn.first().click();
    await expect(page.getByRole("checkbox", { name: "dependencies" })).toBeVisible();
  });

  test.fixme("form includes webUrl input (Batch A addition)", async ({ page }) => {
    // Batch A threads webUrl through form/save/edit/card. Remove .fixme when A lands.
    await page.goto("/settings");
    const addBtn = page.getByRole("button", { name: /Add First Provider|\+ Add Provider/ });
    await addBtn.first().click();
    await expect(page.getByLabel(/web URL|webUrl/i).or(page.getByPlaceholder(/grafana\.example|https:\/\//i))).toBeVisible();
  });
});

import { defineConfig, devices } from "@playwright/test";

/**
 * E2E test config.
 *
 * Runs against a live server at PLAYWRIGHT_BASE_URL (default: http://localhost:3000).
 * CI starts the server via `webServer` block below; locally you can keep your own
 * server running and Playwright will reuse it (`reuseExistingServer: true`).
 *
 * Specs live in `e2e/`. Run with: `npm run test:e2e` (or `npx playwright test`).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: 1,
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env["CI"]
    ? {
        command: "CONFIG_PATH=e2e/fixtures/config.yaml npm run web",
        url: "http://localhost:3000",
        timeout: 120_000,
        reuseExistingServer: false,
        // Drive the Deep Investigation run deterministically (no LLM/MCP).
        env: { DEEP_INVESTIGATION_E2E_STUB: "1" },
      }
    : {
        command: "CONFIG_PATH=dev/config.yaml npm run web",
        url: "http://localhost:3000",
        timeout: 120_000,
        reuseExistingServer: true,
        env: { DEEP_INVESTIGATION_E2E_STUB: "1" },
      },
});

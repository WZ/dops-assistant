import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ".worktrees/**",
      "e2e/**", // Playwright specs — run via `npm run test:e2e`
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/web"),
    },
  },
});

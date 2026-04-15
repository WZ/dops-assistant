// src/cli/commands/discover.test.ts
import { describe, it, expect } from "vitest";

describe("discover CLI", () => {
  // 30s timeout: the dynamic import pulls in the entire discovery + workflow
  // chain (hundreds of files via Mastra/AI SDK), and cold transforms under
  // vitest can spike past 5s when the worker is contended.
  it("module exports runDiscover function", async () => {
    const mod = await import("./discover.js");
    expect(typeof mod.runDiscover).toBe("function");
  }, 30_000);
});

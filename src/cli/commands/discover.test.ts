// src/cli/commands/discover.test.ts
import { describe, it, expect } from "vitest";

describe("discover CLI", () => {
  it("module exports runDiscover function", async () => {
    const mod = await import("./discover.js");
    expect(typeof mod.runDiscover).toBe("function");
  });
});

import { describe, it, expect } from "vitest";
import { Memory } from "@mastra/memory";
import { createMemory } from "./memory.js";

describe("createMemory", () => {
  it("returns a Memory instance", () => {
    const memory = createMemory({ storage: "memory", dbPath: ".dops/memory.db" });
    expect(memory).toBeInstanceOf(Memory);
  });

  it("returns a Memory instance with default config", () => {
    const memory = createMemory({ storage: "memory", dbPath: ".dops/memory.db" });
    expect(memory).toBeDefined();
  });

  it("accepts libsql storage config without throwing", () => {
    const memory = createMemory({ storage: "libsql", dbPath: ".dops/memory.db" });
    expect(memory).toBeInstanceOf(Memory);
  });
});

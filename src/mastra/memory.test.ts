import { describe, it, expect } from "vitest";
import { Memory } from "@mastra/memory";
import { createMemory, WorkingMemorySchema } from "./memory.js";

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
    // createMemory ignores the storage type for now (libsql wired later)
    const memory = createMemory({ storage: "libsql", dbPath: ".dops/memory.db" });
    expect(memory).toBeInstanceOf(Memory);
  });
});

describe("WorkingMemorySchema", () => {
  it("parses an empty object successfully", () => {
    const result = WorkingMemorySchema.parse({});
    expect(result).toEqual({});
  });

  it("parses a full working memory object", () => {
    const input = {
      userRole: "DevOps Engineer",
      teamContext: "Platform team",
      knownServices: ["payments-api", "auth-service"],
      recentTopics: ["latency", "db connections"],
    };
    const result = WorkingMemorySchema.parse(input);
    expect(result.userRole).toBe("DevOps Engineer");
    expect(result.knownServices).toEqual(["payments-api", "auth-service"]);
  });
});

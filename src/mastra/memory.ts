import { Memory } from "@mastra/memory";
import type { Config } from "../config/schema.js";

export function createMemory(_memoryConfig: Config["memory"]) {
  // For now, use default in-memory storage.
  // LibSQL storage will be wired when @mastra/libsql is configured.
  return new Memory({});
}

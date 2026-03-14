import { Memory } from "@mastra/memory";
import { z } from "zod";
import type { Config } from "../config/schema.js";

export const WorkingMemorySchema = z.object({
  userRole: z.string().optional(),
  teamContext: z.string().optional(),
  knownServices: z.array(z.string()).optional(),
  recentTopics: z.array(z.string()).optional(),
});

export function createMemory(_memoryConfig: Config["memory"]) {
  // For now, use default in-memory storage.
  // LibSQL storage will be wired when @mastra/libsql is configured.
  return new Memory({});
}

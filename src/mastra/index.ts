import { Mastra } from "@mastra/core";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Config } from "../config/schema.js";
import { createMemory } from "./memory.js";

export function createModel(llmConfig: Config["llm"]) {
  const provider = createOpenAICompatible({
    name: "openai-compatible",
    baseURL: llmConfig.baseURL ?? "https://api.openai.com/v1",
    apiKey: llmConfig.apiKey,
  });
  return provider.chatModel(llmConfig.model);
}

export function createMastraInstance(config: Pick<Config, "llm"> & { memory?: Config["memory"] }) {
  const model = createModel(config.llm);
  const memory = createMemory(config.memory ?? { storage: "memory", dbPath: ".dops/memory.db" });
  return new Mastra({
    agents: {},
    workflows: {},
    memory: { chat: memory },
  });
}

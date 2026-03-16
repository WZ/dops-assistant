import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Config } from "../config/schema.js";

export function createModel(llmConfig: Config["llm"]) {
  const provider = createOpenAICompatible({
    name: "openai-compatible",
    baseURL: llmConfig.baseURL ?? "https://api.openai.com/v1",
    apiKey: llmConfig.apiKey,
  });
  return provider.chatModel(llmConfig.model);
}

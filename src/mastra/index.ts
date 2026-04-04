import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import type { Config } from "../config/schema.js";

export function createModel(llmConfig: Config["llm"]) {
  const provider = createOpenAICompatible({
    name: "openai-compatible",
    baseURL: llmConfig.baseURL ?? "https://api.openai.com/v1",
    apiKey: llmConfig.apiKey,
  });
  const baseModel = provider.chatModel(llmConfig.model);

  // Use a moderate default (4096) instead of config.maxTokens (10000).
  // 10000 causes "max_tokens must be at least 1, got -N" errors when input
  // context is large (chat follow-ups after Deep investigations with 100K+ tokens).
  // 4096 fits within available budget even with very large inputs, while still
  // being enough for chat responses and investigation synthesis.
  return wrapLanguageModel({
    model: baseModel,
    middleware: {
      specificationVersion: "v3" as const,
      transformParams: async ({ params }) => ({
        ...params,
        maxOutputTokens: params.maxOutputTokens ?? 4096,
      }),
    },
  });
}

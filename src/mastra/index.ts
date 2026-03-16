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

  // Wrap model to inject maxOutputTokens from config into every call
  return wrapLanguageModel({
    model: baseModel,
    middleware: {
      specificationVersion: "v3" as const,
      transformParams: async ({ params }) => ({
        ...params,
        maxOutputTokens: params.maxOutputTokens ?? llmConfig.maxTokens ?? 16384,
      }),
    },
  });
}

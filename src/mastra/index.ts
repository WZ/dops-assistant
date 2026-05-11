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

  // Default to 4096 output tokens. Higher values risk "max_tokens must be at
  // least 1, got -N" errors when the input context is large (chat follow-ups
  // after Deep investigations push prompt_tokens past
  // (max_model_len - max_tokens), and the upstream gateway clips negative).
  // 4096 fits within available budget even with very large inputs while
  // still being enough for chat responses and investigation synthesis.
  // Discovery overrides this per-call via discovery.maxOutputTokens because
  // its JSON output for large stacks needs a larger budget — see
  // src/workflows/steps/discover/index.ts.
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

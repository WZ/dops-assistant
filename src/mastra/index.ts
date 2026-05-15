import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import type { Config, ReasoningEffort } from "../config/schema.js";

export interface CreateModelOptions {
  /**
   * Per-call reasoning effort injected into providerOptions. When set, every
   * call routed through this wrapped model gets `reasoning_effort: <effort>`
   * merged into `providerOptions["openai-compatible"]`. A caller that already
   * supplied the field at call-time wins — middleware never overwrites an
   * existing value. Leave undefined to preserve current behavior (parameter
   * omitted from the upstream request).
   */
  reasoningEffort?: ReasoningEffort;
}

/**
 * Pure transform exposed for unit-testing the middleware in isolation. Same
 * shape that the `wrapLanguageModel` middleware uses internally; the wrapped
 * model just routes its `transformParams` here. Generic over the params shape
 * so the AI SDK's full `LanguageModelV3CallOptions` flows through unchanged
 * — we only read/write `maxOutputTokens` and `providerOptions`.
 */
export function applyModelMiddleware<
  P extends { maxOutputTokens?: number; providerOptions?: Record<string, Record<string, unknown>> },
>(params: P, opts: CreateModelOptions): P {
  const next: P = {
    ...params,
    maxOutputTokens: params.maxOutputTokens ?? 4096,
  };
  if (opts.reasoningEffort) {
    const providerOptions = { ...(params.providerOptions ?? {}) };
    // @ai-sdk/openai-compatible expects providerOptions under the
    // `openaiCompatible` key with a camelCase `reasoningEffort` field. The
    // provider itself serializes it as snake_case `reasoning_effort` on the
    // wire. The legacy kebab-case `openai-compatible` key still works but
    // logs a deprecation warning, so we prefer the camelCase form.
    const existing = (providerOptions["openaiCompatible"] ?? {}) as Record<string, unknown>;
    if (existing["reasoningEffort"] === undefined) {
      providerOptions["openaiCompatible"] = {
        ...existing,
        reasoningEffort: opts.reasoningEffort,
      };
    }
    next.providerOptions = providerOptions;
  }
  return next;
}

export function createModel(llmConfig: Config["llm"], opts: CreateModelOptions = {}) {
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
      transformParams: async ({ params }) => applyModelMiddleware(params, opts),
    },
  });
}

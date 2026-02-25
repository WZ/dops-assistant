import OpenAI from "openai";
import type { OpenAITool } from "../mcp/client.js";
import type { TimeoutsConfig, RetryConfig } from "../config/schema.js";
import { withTimeout, TimeoutError } from "../utils/timeout.js";
import { withRetry } from "../utils/retry.js";
import {
  llmCallsTotal,
  llmTokensUsedTotal,
} from "../observability/metrics.js";

export type LlmConfig = {
  apiKey: string;
  model: string;
  maxTokens: number;
  baseURL?: string;
};

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
  name?: string;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type LlmResponse =
  | { type: "text"; content: string }
  | { type: "tool_calls"; calls: ToolCall[] };

export class LlmClient {
  private openai: OpenAI;
  private config: LlmConfig;
  private timeouts: TimeoutsConfig;
  private retry: RetryConfig;

  constructor(config: LlmConfig, timeouts: TimeoutsConfig, retry: RetryConfig) {
    this.config = config;
    this.timeouts = timeouts;
    this.retry = retry;
    this.openai = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  async chat(
    messages: Message[],
    tools: OpenAITool[],
    opts?: { responseFormat?: OpenAI.ResponseFormatJSONSchema },
  ): Promise<LlmResponse> {
    try {
      return await withRetry(
        () =>
          withTimeout(
            this.doChat(messages, tools, opts),
            this.timeouts.llmCallMs,
            "LLM chat",
          ),
        {
          maxAttempts: this.retry.maxAttempts,
          baseDelayMs: this.retry.baseDelayMs,
        },
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        llmCallsTotal.inc({ status: "timeout" });
      }
      throw err;
    }
  }

  private async doChat(
    messages: Message[],
    tools: OpenAITool[],
    opts?: { responseFormat?: OpenAI.ResponseFormatJSONSchema },
  ): Promise<LlmResponse> {
    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await this.openai.chat.completions.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        ...(tools.length > 0
          ? { tools: tools as OpenAI.Chat.ChatCompletionTool[] }
          : {}),
        ...(opts?.responseFormat
          ? { response_format: opts.responseFormat }
          : {}),
      });
      llmCallsTotal.inc({ status: "success" });
    } catch (err) {
      const isRateLimit =
        typeof err === "object" &&
        err !== null &&
        "status" in err &&
        (err as { status: number }).status === 429;
      llmCallsTotal.inc({ status: isRateLimit ? "rate_limited" : "error" });
      throw err;
    }

    if (response.usage) {
      llmTokensUsedTotal.inc(
        { type: "prompt" },
        response.usage.prompt_tokens,
      );
      llmTokensUsedTotal.inc(
        { type: "completion" },
        response.usage.completion_tokens,
      );
    }

    const choice = response.choices[0];
    if (!choice) {
      throw new Error(
        "LLM returned no choices (possible content filter or API error)",
      );
    }
    const message = choice.message;

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        type: "tool_calls",
        calls: message.tool_calls.map((tc) => {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            throw new Error(
              `Failed to parse tool arguments for "${tc.function.name}": ${tc.function.arguments}`,
            );
          }
          return { id: tc.id, name: tc.function.name, args };
        }),
      };
    }

    return { type: "text", content: message.content ?? "" };
  }
}

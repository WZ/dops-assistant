import OpenAI from "openai";
import pino from "pino";
import type { OpenAITool } from "../mcp/client.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });
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

/**
 * Internal message type decoupled from OpenAI's ChatCompletionMessage.
 * Uses simplified `tool_calls` (no `type: "function"` wrapper) since we
 * convert to the Responses API format via `convertToResponsesInput()`.
 */
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[];
  name?: string;
};

export type ResponseFormat = {
  type: "json_schema";
  json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type TokenUsage = { inputTokens: number; outputTokens: number };

export type LlmResponse =
  | { type: "text"; content: string; usage?: TokenUsage }
  | { type: "tool_calls"; calls: ToolCall[]; usage?: TokenUsage };


// -- Conversion helpers for Responses API --

type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export function convertToResponsesInput(messages: Message[]): {
  instructions: string | undefined;
  input: ResponsesInputItem[];
} {
  const systemParts: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        if (msg.content) systemParts.push(msg.content);
        break;
      case "user":
        input.push({
          type: "message",
          role: "user",
          content: msg.content ?? "",
        });
        break;
      case "assistant":
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            input.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            });
          }
        } else {
          input.push({
            type: "message",
            role: "assistant",
            content: msg.content ?? "",
          });
        }
        break;
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id ?? "",
          output: msg.content ?? "",
        });
        break;
    }
  }

  return {
    instructions: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    input,
  };
}

export function convertTools(tools: OpenAITool[]): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}> {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    strict: false,
  }));
}

/**
 * Converts our ResponseFormat to the Responses API `text` config shape.
 * The Responses API uses `text: { format: { type: "json_schema", ... } }`
 * (see OpenAI SDK's ResponseTextConfig / ResponseFormatTextConfig types).
 */
export function convertResponseFormat(
  fmt: ResponseFormat,
): { format: { type: "json_schema"; name: string; schema: Record<string, unknown>; strict: boolean } } {
  return {
    format: {
      type: "json_schema",
      name: fmt.json_schema.name,
      schema: fmt.json_schema.schema,
      strict: fmt.json_schema.strict,
    },
  };
}

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
    opts?: { responseFormat?: ResponseFormat; maxOutputTokens?: number; timeoutMs?: number },
  ): Promise<LlmResponse> {
    try {
      return await withRetry(
        () =>
          withTimeout(
            this.doChat(messages, tools, opts),
            opts?.timeoutMs ?? this.timeouts.llmCallMs,
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
    opts?: { responseFormat?: ResponseFormat; maxOutputTokens?: number },
  ): Promise<LlmResponse> {
    const { instructions, input } = convertToResponsesInput(messages);

    const requestParams = {
      model: this.config.model,
      max_output_tokens: opts?.maxOutputTokens ?? this.config.maxTokens,
      ...(instructions ? { instructions } : {}),
      input,
      ...(tools.length > 0
        ? { tools: convertTools(tools), tool_choice: "auto" as const }
        : {}),
      ...(opts?.responseFormat
        ? { text: convertResponseFormat(opts.responseFormat) }
        : {}),
    };

    logger.debug({
      component: "llm",
      model: requestParams.model,
      inputItems: input.length,
      toolCount: tools.length,
      hasInstructions: !!instructions,
      hasResponseFormat: !!opts?.responseFormat,
    }, "Sending Responses API request");

    let response: OpenAI.Responses.Response;
    try {
      response = await this.openai.responses.create(
        requestParams as OpenAI.Responses.ResponseCreateParamsNonStreaming,
      ) as OpenAI.Responses.Response;
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

    const usage: TokenUsage | undefined = response.usage
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : undefined;

    if (response.usage) {
      llmTokensUsedTotal.inc(
        { type: "prompt" },
        response.usage.input_tokens,
      );
      llmTokensUsedTotal.inc(
        { type: "completion" },
        response.usage.output_tokens,
      );
    }

    // Detect truncated responses (Responses API equivalent of finish_reason=length)
    const effectiveMaxTokens = opts?.maxOutputTokens ?? this.config.maxTokens;
    if (response.status === "incomplete") {
      const reason = (response as unknown as { incomplete_details?: { reason?: string } }).incomplete_details?.reason ?? "unknown";
      logger.warn(
        { reason, effectiveMaxTokens, outputTokens: response.usage?.output_tokens },
        "LLM response truncated — returning partial content for caller to handle",
      );
      // Instead of throwing, return whatever text was produced so the caller can retry.
      // The caller's JSON parse will fail and trigger its own recovery logic.
    }

    // Parse response.output items
    const functionCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let textContent = "";

    for (const item of response.output) {
      if (item.type === "function_call") {
        functionCalls.push({
          id: item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
      } else if (item.type === "mcp_call") {
        // Some OpenAI-compatible APIs return mcp_call instead of function_call.
        // Structure is similar: id, name, arguments, server_label.
        const mcpItem = item as unknown as { id: string; name: string; arguments: string };
        functionCalls.push({
          id: mcpItem.id,
          name: mcpItem.name,
          arguments: mcpItem.arguments,
        });
      } else if (item.type === "reasoning") {
        // Chain-of-thought reasoning from some APIs — safely ignore.
      } else if (item.type === "message") {
        for (const part of item.content) {
          if (part.type === "output_text") {
            textContent += part.text;
          } else {
            logger.warn({ component: "llm", partType: part.type }, "Unhandled response content part type");
          }
        }
      } else {
        logger.warn({ component: "llm", itemType: item.type }, "Unhandled response output item type");
      }
    }

    logger.debug({
      component: "llm",
      hasToolCalls: functionCalls.length > 0,
      toolCallCount: functionCalls.length,
      contentPreview: textContent.slice(0, 200),
    }, "LLM response received");

    if (functionCalls.length > 0) {
      // When no tools were provided, any function_call items are hallucinations
      // (e.g. "<|constrain|>json"). Ignore them and fall through to text handling.
      if (tools.length > 0) {
        return {
          type: "tool_calls",
          usage,
          calls: functionCalls.map((fc) => {
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(fc.arguments) as Record<string, unknown>;
            } catch {
              throw new Error(
                `Failed to parse tool arguments for "${fc.name}": ${fc.arguments}`,
              );
            }
            return { id: fc.id, name: fc.name, args };
          }),
        };
      } else {
        logger.warn(
          { hallucinated: functionCalls.map((fc) => fc.name) },
          "Ignoring hallucinated function calls (no tools were provided)",
        );
      }
    }

    if (response.output.length === 0 && response.status !== "incomplete") {
      throw new Error(
        "LLM returned no output (possible content filter or API error)",
      );
    }

    return { type: "text", content: textContent, usage };
  }
}

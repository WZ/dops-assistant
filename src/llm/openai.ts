import OpenAI from "openai";
import type { OpenAITool } from "../mcp/client.js";

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

  constructor(config: LlmConfig) {
    this.config = config;
    this.openai = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  async chat(messages: Message[], tools: OpenAITool[]): Promise<LlmResponse> {
    const response = await this.openai.chat.completions.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      ...(tools.length > 0 ? { tools: tools as OpenAI.Chat.ChatCompletionTool[] } : {}),
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("LLM returned no choices (possible content filter or API error)");
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
            throw new Error(`Failed to parse tool arguments for "${tc.function.name}": ${tc.function.arguments}`);
          }
          return {
            id: tc.id,
            name: tc.function.name,
            args,
          };
        }),
      };
    }

    return { type: "text", content: message.content ?? "" };
  }
}

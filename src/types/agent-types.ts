/**
 * Shared agent types used by the server, CLI, and adapter layers.
 * Extracted from the legacy src/agent/types.ts.
 */

import type { Message, TokenUsage } from "./llm-types.js";
import type { ServiceConfig } from "../config/schema.js";

export type AgentMode = "proactive" | "conversational";

export type ChatRequest = {
  mode: AgentMode;
  message: string;
  serviceContext?: ServiceConfig[];
  skillContext?: string;
  supportsInlineCharts?: boolean;
  history?: Message[];
  correlationId?: string;
  onToolCall?: (name: string, args: Record<string, unknown>, result?: string) => void;
  onTokenUsage?: (usage: TokenUsage) => void;
  onStreamStart?: () => void;
  onStreamDelta?: (delta: { type: "reasoning" | "content"; content: string }) => void;
};

export type ImageAttachment = {
  filename: string;
  mimeType: string;
  data: Buffer;
};

export type ChatResponse = {
  response: string;
  updatedHistory: Message[];
  images: ImageAttachment[];
};

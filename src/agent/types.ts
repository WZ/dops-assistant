import type { Message, TokenUsage } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";

export type AgentMode = "proactive" | "conversational";

export type ChatRequest = {
  mode: AgentMode;
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
  correlationId?: string;
  onToolCall?: (name: string, args: Record<string, unknown>, result?: string) => void;
  onTokenUsage?: (usage: TokenUsage) => void;
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

export type AnomalyAssessment = {
  isAnomaly: boolean;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  affectedMetrics: string[];
  recommendedAction: string;
  timeRangeFrom: string;
  timeRangeTo: string;
};

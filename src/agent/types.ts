import type { Message, TokenUsage } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";

export type AgentMode = "proactive" | "conversational";

export type AgentTask = {
  mode: AgentMode;
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
  correlationId?: string;
  onTokenUsage?: (usage: TokenUsage) => void;
};

export type AgentResult = {
  response: string;
  updatedHistory: Message[];
};

export type AnomalyAssessment = {
  isAnomaly: boolean;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  affectedMetrics: string[];
  recommendedAction: string;
};

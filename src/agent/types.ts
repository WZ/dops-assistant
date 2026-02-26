import type { Message } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";

export type AgentMode = "proactive" | "conversational";

export type AgentTask = {
  mode: AgentMode;
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
  correlationId?: string;
};

export type ImageAttachment = {
  filename: string;
  mimeType: string;
  data: Buffer;
};

export type AgentResult = {
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
};

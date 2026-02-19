import type { Message } from "../llm/openai.js";
import type { ServiceConfig } from "../config/schema.js";

export type AgentMode = "proactive" | "conversational";

export type AgentTask = {
  mode: AgentMode;
  message: string;
  serviceContext?: ServiceConfig[];
  history?: Message[];
};

export type AgentResult = {
  response: string;
  updatedHistory: Message[];
};

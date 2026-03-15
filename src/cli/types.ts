import type { RcaReport } from "../types/rca-types.js";

export type CliCommand = "investigate" | "chat" | "mcp-check" | "e2e" | "interactive";

export type TokenSummary = {
  input: number;
  output: number;
  total: number;
};

export type ToolCallRecord = {
  name: string;
  argsSummary: string;
  durationMs?: number;
  // --verbose only:
  result?: string;
  error?: string;
  phase?: string;
};

export type CliFlags = {
  timeout: number;
  verbose: boolean;
  config: string;
  history: boolean;
};

export type InvestigateOutput = {
  command: "investigate";
  service: string;
  status: "success" | "error";
  durationMs: number;
  tokens: TokenSummary | null;
  toolCalls: ToolCallRecord[];
  history: boolean;
  result: RcaReport | null;
  error: string | null;
};

export type ChatOutput = {
  command: "chat";
  message: string;
  status: "success" | "error";
  durationMs: number;
  tokens: TokenSummary | null;
  toolCalls: ToolCallRecord[];
  result: { response: string } | null;
  error: string | null;
};

export type McpCheckProvider = {
  name: string;
  status: "connected" | "error";
  toolsCount: number;
  tools: string[];
  error: string | null;
};

export type McpCheckOutput = {
  command: "mcp-check";
  status: "success" | "error";
  durationMs: number;
  providers: McpCheckProvider[];
};

export type E2eStepResult = {
  name: string;
  status: "pass" | "fail" | "skipped";
  durationMs: number;
  error: string | null;
  assertions?: Array<{
    field: string;
    expected: unknown;
    actual: unknown;
    pass: boolean;
  }>;
};

export type E2eOutput = {
  command: "e2e";
  scenario: string;
  status: "pass" | "fail";
  durationMs: number;
  steps: E2eStepResult[];
};

// Client to Server
export type ClientMessage =
  | { type: "chat"; message: string }
  | { type: "deep_investigate"; investigationId: string; message: string }
  | { type: "new_session" };

// Phase stats emitted on phase completion
export type PhaseStats = {
  observationCount: number;
  criticalCount: number;
  toolCalls: number;
  iterations: number;
  durationMs: number;
};

// Server to Client
export type ChartSeries = {
  metric: string;
  instance?: string;
  query?: string;
  values: [string, number][];
  min?: number;
  max?: number;
  avg?: number;
};

export type ServerMessage =
  | { type: "chat"; role: "user" | "assistant" | "system"; content: string; investigationId?: string; report?: unknown; chartData?: ChartSeries[] }
  | { type: "chat:tool_call"; tool: string; status: "calling" | "complete" }
  | { type: "investigation:started"; id: string; service: string; query: string }
  | { type: "investigation:phase"; phase: string; status: "running" | "complete" | "failed"; data?: unknown; stats?: PhaseStats }
  | { type: "investigation:progress"; phase: string; step: string }
  | { type: "investigation:tool_call"; phase: string; tool: string; args: Record<string, unknown>; status: "calling" | "success" | "error"; result?: string; durationMs?: number }
  | { type: "investigation:iteration"; phase: string; iteration: number; maxIterations: number; description: string }
  | { type: "investigation:complete"; id: string; report: unknown }
  | { type: "investigation:failed"; id: string; error: string }
  | { type: "deep_investigate:tool_call"; investigationId: string; tool: string; args: Record<string, unknown>; status: "calling" | "success" | "error" }
  | { type: "session_cleared" }
  | { type: "context_switch"; previousService: string; newService: string }
  | { type: "services:health"; data: unknown[] }
  | { type: "chat:stream_start" }
  | { type: "chat:stream_delta"; content: string; reasoning?: boolean }
  | { type: "chat:stream_end"; content: string; chartData?: ChartSeries[]; skillsUsed?: string[] }
  | { type: "investigation:phase_usage"; investigationId: string; phase: string; inputTokens: number; outputTokens: number; durationMs: number }
  | { type: "investigation:total_usage"; investigationId: string; inputTokens: number; outputTokens: number; durationMs: number }
  | { type: "chat:usage"; inputTokens: number; outputTokens: number; durationMs: number }
  | { type: "error"; message: string };

// Client to Server
export type ClientMessage =
  | { type: "chat"; message: string }
  | { type: "deep_investigate"; investigationId: string; message: string };

// Phase stats emitted on phase completion
export type PhaseStats = {
  observationCount: number;
  criticalCount: number;
  toolCalls: number;
  iterations: number;
  durationMs: number;
};

// Server to Client
export type ServerMessage =
  | { type: "chat"; role: "user" | "assistant" | "system"; content: string }
  | { type: "investigation:started"; id: string; service: string }
  | { type: "investigation:phase"; phase: string; status: "running" | "complete" | "failed"; data?: unknown; stats?: PhaseStats }
  | { type: "investigation:progress"; phase: string; step: string }
  | { type: "investigation:tool_call"; phase: string; tool: string; args: Record<string, unknown>; status: "calling" | "success" | "error"; result?: string; durationMs?: number }
  | { type: "investigation:iteration"; phase: string; iteration: number; maxIterations: number; description: string }
  | { type: "investigation:complete"; id: string; report: unknown }
  | { type: "investigation:failed"; id: string; error: string }
  | { type: "deep_investigate:response"; investigationId: string; content: string }
  | { type: "deep_investigate:tool_call"; investigationId: string; tool: string; args: Record<string, unknown>; status: "calling" | "success" | "error" }
  | { type: "services:health"; data: unknown[] }
  | { type: "error"; message: string };

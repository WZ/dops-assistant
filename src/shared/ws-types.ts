// Client to Server
export type ClientMessage = {
  type: "chat";
  message: string;
};

// Server to Client
export type ServerMessage =
  | { type: "chat"; role: "user" | "assistant" | "system"; content: string }
  | { type: "investigation:started"; id: string; service: string }
  | { type: "investigation:phase"; phase: string; status: "running" | "complete" | "failed"; data?: unknown }
  | { type: "investigation:progress"; phase: string; step: string }
  | { type: "investigation:complete"; id: string; report: unknown }
  | { type: "investigation:failed"; id: string; error: string }
  | { type: "services:health"; data: unknown[] }
  | { type: "error"; message: string };

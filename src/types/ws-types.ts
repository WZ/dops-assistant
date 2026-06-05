import type { ServiceConfig } from "../config/schema.js";
import type { ValidatedServiceConfig } from "./discovery-types.js";
import type { StackSummary } from "./stack-types.js";

// Client to Server
export type ClientMessage =
  // `immediate` marks an explicit, unambiguous investigation request (e.g. the
  // Investigate button on the service detail page). The server skips both the
  // LLM intent router and the cancellable confirm-dispatch window and kicks the
  // runner off at once. Typed free-text chat omits it and keeps both safeguards.
  | { type: "chat"; message: string; serviceContext?: string; immediate?: boolean }
  | { type: "deep_investigate"; investigationId: string; message: string }
  // Deep mode (Step 3): re-examine a COMPLETED investigation's ruled-out
  // hypotheses with deeper read-only re-queries. Distinct from `deep_investigate`
  // above, which is free-text follow-up chat about an investigation.
  | { type: "deep_mode_investigate"; investigationId: string }
  // Autonomous orchestrator (Approach D): run the unbounded read-only move-loop
  // seeded from a completed investigation's context. Heavier opt-in than deep
  // mode; gated behind config.agent.orchestratorEnabled.
  | { type: "orchestrator_investigate"; investigationId: string }
  // Operator's reply to an `orchestrator:operator_pause` prompt (increment 5):
  // "continue" resets strikes and resumes the move-loop; "escalate"/"wait" stop
  // it with that disposition. Matched to the paused run by investigationId.
  | { type: "orchestrator_decision"; investigationId: string; decision: "continue" | "escalate" | "wait" }
  // Operator hit Stop on an in-flight Deep Investigation. Aborts the run (the
  // loop stops at its next guard check → "aborted") and unblocks it if paused.
  | { type: "orchestrator_stop"; investigationId: string }
  | { type: "rerun"; investigationId: string; template?: "quick" | "standard" | "full" }
  | { type: "new_session" }
  | { type: "discover" }
  | { type: "discover:accept"; services: ServiceConfig[] }
  | { type: "discover:reject" }
  | { type: "scan:trigger" }
  // Cancel an investigation that's still inside its pre-dispatch confirmation
  // window. No-op if the investigation already started running. See the
  // confirm-dispatch flow in ws-handler.ts (chat-originated investigations only).
  | { type: "investigation:cancel_dispatch"; id: string };

// Phase stats emitted on phase completion
export type PhaseStats = {
  observationCount: number;
  criticalCount: number;
  toolCalls: number;
  iterations: number;
  durationMs: number;
  error?: string;
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

/** One step in a structured agent/progress stream (deep mode). Rendered with
 *  a status icon, a colored verb, an optional target (queries shown distinctly),
 *  trailing detail, and optional indentation for grouped sub-steps. */
export type AgentStreamEvent = {
  seq: number;
  /** Leading action word, colored by the renderer (queried, testing, resurrected…). */
  verb: string;
  /** The object of the action (a query name, a hypothesis, an anomaly). */
  target?: string;
  /** Render the target as a query (distinct color) vs plain text. */
  targetKind?: "query" | "plain";
  /** Trailing muted detail (e.g. "→ climbs sawtooth", "(contradicted)"). */
  detail?: string;
  /** Drives the icon + verb color: running ◉ · done ✓ · rejected ✗ · strong ✓(green). */
  status: "running" | "done" | "rejected" | "strong";
  /** Nesting level for grouped sub-steps (0 = top level). */
  indent?: number;
};

/** Footer stats for a completed agent stream. */
export type AgentStreamStats = {
  examined: number;
  toolCalls: number;
  resurrected: number;
  shaken: number;
  durationMs: number;
};

/** Footer stats for a completed autonomous-orchestrator run. */
export type OrchestratorStreamStats = {
  moves: number;
  toolCalls: number;
  subagents: number;
  tokensSpent: number;
  strikes: number;
  depth: number;
  durationMs: number;
};

/** One link in a completed run's causal chain (increment 6, source attribution).
 *  Ordered cause→effect: the incident service, each dependency the agent followed
 *  into, then the confirmed root cause. `evidence` is the observation/finding that
 *  supports this link (absent for the incident anchor). */
export type CausalChainLink = {
  /** Display label: a service name, or "root cause: <hypothesis>". */
  label: string;
  kind: "incident" | "followed" | "root-cause";
  /** Short attribution — the finding/observation this link rests on. */
  evidence?: string;
};

export type ServerMessage =
  | { type: "chat"; role: "user" | "assistant" | "system"; content: string; investigationId?: string; report?: unknown; chartData?: ChartSeries[] }
  | { type: "chat:tool_call"; tool: string; status: "calling" | "complete" }
  // Pre-dispatch confirmation window: server announces an investigation is
  // ABOUT to fire, with a timerMs cancel window. Client renders the coral
  // banner and may send `investigation:cancel_dispatch` to abort. Only
  // chat-originated investigations emit this — webhook/scan/health-poller
  // paths skip the confirm flow.
  | { type: "investigation:confirm_dispatch"; id: string; service: string; query: string; timerMs: number }
  // Sent after `confirm_dispatch` if the user cancels within the window.
  | { type: "investigation:dispatch_cancelled"; id: string; service: string }
  | { type: "investigation:started"; id: string; service: string; query: string; parentInvestigationId?: string }
  | { type: "investigation:phase"; id: string; phase: string; status: "running" | "complete" | "failed"; data?: unknown; stats?: PhaseStats }
  | { type: "investigation:progress"; id: string; phase: string; step: string }
  | { type: "investigation:tool_call"; id: string; phase: string; tool: string; args: Record<string, unknown>; status: "calling" | "success" | "error"; result?: string; durationMs?: number }
  | { type: "investigation:iteration"; id: string; phase: string; iteration: number; maxIterations: number; description: string }
  | { type: "investigation:complete"; id: string; report: unknown }
  | { type: "investigation:failed"; id: string; error: string }
  | { type: "deep_investigate:tool_call"; investigationId: string; tool: string; args: Record<string, unknown>; status: "calling" | "success" | "error" }
  // Deep mode (Step 3) lifecycle + a dedicated, structured progress stream
  // (rendered as a colored/grouped agent stream, not the chat thinking block).
  | { type: "deep_mode:started"; investigationId: string }
  | { type: "deep_mode:step"; investigationId: string; event: AgentStreamEvent }
  | { type: "deep_mode:complete"; investigationId: string; report: unknown; stats?: AgentStreamStats }
  | { type: "deep_mode:error"; investigationId: string; message: string }
  | { type: "orchestrator:started"; investigationId: string }
  | { type: "orchestrator:step"; investigationId: string; event: AgentStreamEvent }
  | { type: "orchestrator:complete"; investigationId: string; outcome: string; stats?: OrchestratorStreamStats; causalChain?: CausalChainLink[]; traceSummary?: string }
  // Strike limit reached (increment 5): the loop is awaiting an operator
  // decision (continue / escalate / instrument-&-wait). The client renders the
  // pause card and replies with `orchestrator_decision`.
  | { type: "orchestrator:operator_pause"; investigationId: string; strikes: number; hypothesesTried?: string[] }
  | { type: "orchestrator:error"; investigationId: string; message: string }
  | { type: "session_cleared" }
  | { type: "context_switch"; previousService: string; newService: string }
  | { type: "services:health"; data: unknown[] }
  | { type: "chat:stream_start" }
  | { type: "chat:stream_delta"; content: string; reasoning?: boolean }
  | { type: "chat:stream_end"; content: string; chartData?: ChartSeries[]; skillsUsed?: string[]; id?: string; createdAt?: string; investigationId?: string; serviceContext?: string }
  | { type: "investigation:phase_usage"; investigationId: string; phase: string; inputTokens: number; outputTokens: number; durationMs: number }
  | { type: "investigation:total_usage"; investigationId: string; inputTokens: number; outputTokens: number; durationMs: number }
  | { type: "chat:usage"; inputTokens: number; outputTokens: number; durationMs: number }
  | { type: "discover:phase"; phase: string; status: "running" | "complete" }
  | { type: "discover:iteration"; phase: string; iteration: number; maxIterations: number; description: string }
  | { type: "discover:tool_call"; phase: string; tool: string; args: Record<string, unknown>; status: "calling" | "success" | "error"; result?: string; durationMs?: number }
  | { type: "discover:complete"; services: ValidatedServiceConfig[] }
  | { type: "discover:retry"; attempt: number; maxRetries: number; reason: string }
  | { type: "discover:error"; message: string }
  | { type: "discover:pending"; services: ValidatedServiceConfig[] }
  | { type: "discover:resolved" }
  | { type: "discover:phase_usage"; phase: string; inputTokens: number; outputTokens: number; durationMs: number }
  | { type: "discover:phase_timing"; phase: string; durationMs: number }
  | { type: "discover:total_usage"; inputTokens: number; outputTokens: number; durationMs: number }
  | { type: "error"; message: string }
  | { type: "stack:list"; stacks: StackSummary[] }
  | { type: "stack:health"; stacks: Array<{ id: string; slug: string; healthSummary: { healthy: number; degraded: number; down: number; unknown: number; total: number } }> }
  | { type: "stack:switched"; stackId: string }
  | { type: "scan:started"; runId: string; stackId: string; trigger: "manual" | "cron"; startedAt: number }
  | { type: "scan:probe_complete"; runId: string; stackId: string; stats: { servicesProbed: number; rulesApplied: number; queriesExecuted: number; probeErrors: number; queriesEmpty: number; durationMs: number } }
  | { type: "scan:triage_complete"; runId: string; stackId: string; detail: { hitsRaw: number; hitsAfterDedup: number; dispatched: Array<{ service: string; ruleName: string; value: number; severity: number }>; dropped: Array<{ service: string; ruleName: string; value: number; severity: number }>; dedupedList: Array<{ service: string; ruleName: string; reason: string }> } }
  | { type: "scan:investigation_dispatched"; runId: string; stackId: string; investigationId: string; service: string; ruleName: string }
  | { type: "scan:complete"; runId: string; stackId: string; status: "complete"; durationMs: number; hitsDispatched: number }
  | { type: "scan:failed"; runId: string; stackId: string; error: string }
  | { type: "scan:skipped"; runId: string; stackId: string; reason: string };

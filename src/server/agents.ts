/**
 * src/server/agents.ts
 *
 * Wraps Mastra agents and investigation workflow into duck-typed interfaces
 * that the web server (ws-handler.ts) and CLI (cli/App.tsx) depend on.
 *
 * Satisfies the following contracts:
 *
 *   ChatAgent-like:           chat(task: ChatRequest): Promise<ChatResponse>
 *   InvestigationAgent-like:  investigate(service, anomaly, id, onUsage, msg,
 *                               onTool, onPhase, onIteration, skillCtx): Promise<RcaReport>
 *
 * NOTE: The chat adapter preserves Mastra streaming, but flattens history and
 * request-specific context into a single prompt string so it can pass a
 * supported input shape to agent.stream().
 */

import { randomUUID } from "node:crypto";
import type { ServiceConfig, DiscoveryConfig } from "../config/schema.js";
import type { RcaReport, DeepModeReport } from "../types/rca-types.js";
import type { AgentStreamEvent } from "../types/ws-types.js";
import { runDeepMode, buildReexamineTargets, widenTimeRange } from "../workflows/steps/deep-mode.js";
import { createGatherEvidence } from "../workflows/steps/hypothesis-requery.js";
import { createLogger } from "../logger.js";

const logger = createLogger("mastra-chat");
import type { DiscoverOptions, IDiscoverAgent, OnToolCallEnriched, OnIteration } from "../types/agent-interfaces.js";
import type { InvestigationTemplate } from "../config/schema.js";
import type { ChatRequest, ChatResponse, ImageAttachment } from "../types/agent-types.js";
import type { TokenUsage } from "../types/llm-types.js";
import type { ValidatedServiceConfig } from "../types/discovery-types.js";
import type { DiscoveryResult } from "../types/agent-interfaces.js";
import type { ProbeMetricRule } from "../config/schema.js";
import { createChatAgent } from "../agents/chat.js";
import { wrapUntrusted } from "../agents/shared/prompt-helpers.js";
import { logLlmCall, logLlmCallFirstChunk, logLlmCallStart, logToolCall, newCallId, type ToolCallEvent } from "./llm-logger.js";
import { createInvestigationWorkflow, type WorkflowConfig } from "../workflows/investigation.js";
import { runDiscovery } from "../workflows/discovery.js";
import { createModel } from "../mastra/index.js";
import type { Config } from "../config/schema.js";
import { getEffectiveReasoningEffort } from "./llm-settings.js";
import type { MastraProvider } from "../mcp/provider.js";
import { getAllTools } from "../mcp/provider.js";
import { coerceLokiArgs } from "../workflows/tool-utils.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { LanguageModel } from "ai";
import type { LlmRetryConfig } from "../agents/shared/llm-retry.js";
import { LlmUnavailableError } from "../agents/shared/llm-errors.js";
import { runAutonomousOrchestrator } from "../agents/orchestrator-llm.js";
import { traceEntryToStreamEvent } from "../agents/orchestrator-stream.js";
import type { OrchestratorGuards, OrchestratorResult, OrchestratorState } from "../agents/orchestrator.js";
import { refineReportFromDeepRun, type RefineInput, type RefinedNarrative } from "../agents/orchestrator-refine.js";
import type { CorroborationContext, NormalizedObservation } from "../workflows/steps/corroboration.js";
import type { Skill } from "../skills/store.js";

/** Conservative default safety harness for the autonomous orchestrator. The
 *  budget guard is the cost backstop; defaults stay low because an autonomous
 *  run is 3-10x a normal investigation. Config-tunable knobs come later. */
export const DEFAULT_ORCHESTRATOR_GUARDS: OrchestratorGuards = {
  maxTokens: 150_000,
  maxDepth: 3,
  maxSubagents: 3,
  maxStrikes: 3,
  maxToolCalls: 40,
  wallClockMs: 10 * 60_000,
  // Per-op watchdog: a single gather/subagent gets ~2.5 min before it's
  // abandoned. A quick subagent investigation normally finishes well under
  // that; the bound just stops one hung MCP/LLM call from stranding the loop.
  opTimeoutMs: 150_000,
};

type MastraChatAgent = ReturnType<typeof createChatAgent>;
type MastraStreamInput = Parameters<MastraChatAgent["stream"]>[0];

interface MastraChatAgentSet {
  inlineCharts: MastraChatAgent;
  imageAttachments: MastraChatAgent;
}

function buildServicesContext(services?: ServiceConfig[]): string {
  if (!services?.length) return "";

  return services.map((service) => {
    const metricHints = service.metrics.length > 0
      ? ` metrics=${service.metrics.map((metric) => `${metric.description} (${metric.query})`).join(", ")}`
      : "";
    const logLabels = service.logLabels && Object.keys(service.logLabels).length > 0
      ? ` logLabels=${JSON.stringify(service.logLabels)}`
      : "";
    return `- ${service.name}${metricHints}${logLabels}`;
  }).join("\n");
}

function buildHistoryContext(task: ChatRequest): string {
  const historyLines = (task.history ?? [])
    .filter((message) => (
      message.role === "system" ||
      message.role === "user" ||
      message.role === "assistant"
    ))
    .map((message) => `${message.role.toUpperCase()}: ${message.content ?? ""}`);

  const sections = [
    task.skillContext
      ? `${task.skillContext}\nIf a skill matches the user's question, use it to provide informed answers.`
      : "",
    task.serviceContext?.length
      ? `Configured services:\n${buildServicesContext(task.serviceContext)}`
      : "",
    historyLines.length > 0
      ? `Conversation so far:\n${historyLines.join("\n")}`
      : "",
    `USER: ${wrapUntrusted("user_message", task.message)}`,
  ].filter(Boolean);

  return sections.join("\n\n");
}

function unwrapToolText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return String(result ?? "");

  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "");
    if (textParts.length > 0) return textParts.join("\n");
  }

  return JSON.stringify(result);
}

function extractToolImages(toolName: string, result: unknown): ImageAttachment[] {
  if (!result || typeof result !== "object") return [];

  const content = (result as {
    content?: Array<{ type?: string; data?: string; mimeType?: string; mediaType?: string }>;
  }).content;
  if (!Array.isArray(content)) return [];

  const attachments: ImageAttachment[] = [];
  for (const part of content) {
    if (part?.type !== "image" || typeof part.data !== "string") continue;
    const mimeType = part.mimeType ?? part.mediaType ?? "image/png";
    const extension = mimeType.split("/")[1] ?? "png";
    attachments.push({
      filename: `${toolName}-${randomUUID().slice(0, 8)}.${extension}`,
      mimeType,
      data: Buffer.from(part.data, "base64"),
    });
  }
  return attachments;
}

/**
 * Truncate MCP tool result to prevent oversized context when fed back to the LLM.
 * Preserves the MCP content wrapper structure.
 */
// Re-export from tool-utils for backward compat — chat Loki truncation uses this
import { truncateMcpResult } from "../workflows/tool-utils.js";

function selectChatAgent(agents: MastraChatAgentSet, task: ChatRequest): MastraChatAgent {
  return task.supportsInlineCharts === false
    ? agents.imageAttachments
    : agents.inlineCharts;
}

// ── ChatAgent adapter ─────────────────────────────────────────────────────────

/**
 * A duck-typed wrapper around the Mastra chat agent that exposes the same
 * `chat()` method the existing server/CLI code calls.
 *
 * Streaming: we keep Mastra's stream() path so the websocket/UI still receive
 * incremental deltas. Request-specific context is flattened into a prompt
 * string before streaming to satisfy Mastra's accepted input shapes.
 *
 * Tool-call visibility: Mastra does not expose per-tool callbacks at the
 * generate/stream level in the same granular way as the old ChatAgent.
 * Tool calls are silently executed inside the Mastra agent loop; the
 * caller still receives a valid response.
 */
export class MastraChatAgentAdapter {
  private mastraAgents: MastraChatAgentSet;
  private llmCallMs?: number;

  constructor(mastraAgents: MastraChatAgentSet, opts?: { llmCallMs?: number }) {
    this.mastraAgents = mastraAgents;
    this.llmCallMs = opts?.llmCallMs;
  }

  async chat(task: ChatRequest): Promise<ChatResponse> {
    const mastraAgent = selectChatAgent(this.mastraAgents, task);
    const prompt = buildHistoryContext(task);
    const streamInput = prompt as MastraStreamInput;
    const collectedImages: ImageAttachment[] = [];
    // Per-call abort signal — the AI SDK has no idle timeout, so a stalled
    // upstream stream hangs forever otherwise. Bound to config.timeouts.llmCallMs.
    const abortSignal = this.llmCallMs && this.llmCallMs > 0
      ? AbortSignal.timeout(this.llmCallMs)
      : undefined;

    // Signal streaming start immediately so UI shows "Thinking..."
    task.onStreamStart?.();

    let responseText = "";
    const chatCallId = newCallId();
    const chatToolCalls: ToolCallEvent[] = [];
    let chatInputTokens = 0;
    let chatOutputTokens = 0;
    const chatStartMs = Date.now();
    let firstChunkLogged = false;
    let chatError: string | undefined;
    logLlmCallStart({ callId: chatCallId, agent: "chat", promptChars: prompt.length, prompt });
    try {
      const stream = await (abortSignal
        ? mastraAgent.stream(streamInput, { abortSignal })
        : mastraAgent.stream(streamInput));

      for await (const chunk of stream.fullStream) {
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          logLlmCallFirstChunk(chatCallId, "chat", Date.now() - chatStartMs);
        }
        const c = chunk as any;
        // Mastra wraps all events in { type, runId, from, payload }
        const p = c.payload ?? c;

        if (c.type === "reasoning-delta") {
          const text = p.textDelta ?? p.delta ?? p.text ?? "";
          if (text) task.onStreamDelta?.({ type: "reasoning", content: text });
        } else if (c.type === "text-delta") {
          const text = p.textDelta ?? p.delta ?? p.text ?? "";
          if (text) {
            responseText += text;
            task.onStreamDelta?.({ type: "content", content: text });
          }
        } else if (c.type === "tool-call") {
          const rawName = p.toolName ?? "unknown";
          const idx = rawName.indexOf("_");
          const toolName = idx > 0 ? rawName.slice(idx + 1) : rawName;
          const argsStr = JSON.stringify(p.args ?? {}).slice(0, 2000);
          logToolCall(chatCallId, "chat", { tool: toolName, argsChars: argsStr.length, args: argsStr, resultChars: 0 });
          task.onToolCall?.(toolName, p.args ?? {});
        } else if (c.type === "tool-result") {
          const rawName = p.toolName ?? "unknown";
          const idx = rawName.indexOf("_");
          const toolName = idx > 0 ? rawName.slice(idx + 1) : rawName;
          const result = p.result ?? "";
          const resultStr = unwrapToolText(result);
          collectedImages.push(...extractToolImages(toolName, result));
          const toolResultEvent: ToolCallEvent = { tool: toolName, argsChars: 0, resultChars: resultStr.length, result: resultStr.slice(0, 500) };
          chatToolCalls.push(toolResultEvent);
          logToolCall(chatCallId, "chat", toolResultEvent);
          task.onToolCall?.(toolName, p.args ?? {}, resultStr);
        }
      }

      // Emit token usage from the stream (available after stream is consumed)
      try {
        const usage = await (stream as any).totalUsage ?? await (stream as any).usage;
        if (usage && (usage.inputTokens || usage.outputTokens)) {
          chatInputTokens = usage.inputTokens ?? 0;
          chatOutputTokens = usage.outputTokens ?? 0;
          task.onTokenUsage?.({ inputTokens: chatInputTokens, outputTokens: chatOutputTokens });
        }
      } catch { /* usage not available — ignore */ }
    } catch (err) {
      chatError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: chatError }, "stream error");
      if (!responseText) {
        try {
          // Reuse a fresh timeout for the fallback — the original signal may
          // have already fired (that's likely why we're in this catch block).
          const fallbackSignal = this.llmCallMs && this.llmCallMs > 0
            ? AbortSignal.timeout(this.llmCallMs)
            : undefined;
          const result = await (fallbackSignal
            ? mastraAgent.generate(prompt, { abortSignal: fallbackSignal })
            : mastraAgent.generate(prompt));
          responseText = result.text ?? "";
          task.onStreamDelta?.({ type: "content", content: responseText });
          chatError = undefined; // fallback succeeded
          // Emit token usage from generate fallback
          const usage = (result as any).totalUsage ?? (result as any).usage;
          if (task.onTokenUsage && usage && (usage.inputTokens || usage.outputTokens)) {
            task.onTokenUsage({
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
            });
          }
        } catch (genErr) {
          const errMsg = genErr instanceof Error ? genErr.message : String(genErr);
          chatError = errMsg;
          responseText = `Error: ${errMsg}`;
          task.onStreamDelta?.({ type: "content", content: responseText });
        }
      }
    }

    logLlmCall({
      callId: chatCallId,
      agent: "chat",
      promptChars: prompt.length,
      prompt,
      responseChars: responseText.length,
      response: responseText,
      inputTokens: chatInputTokens,
      outputTokens: chatOutputTokens,
      durationMs: Date.now() - chatStartMs,
      toolCalls: chatToolCalls,
      error: chatError,
    });

    return {
      response: responseText,
      updatedHistory: [],
      images: collectedImages,
    };
  }
}

// ── InvestigationAgent adapter ────────────────────────────────────────────────

/**
 * A duck-typed wrapper around the Mastra investigation workflow that exposes
 * the same `investigate()` method signature as the existing InvestigationAgent.
 *
 * The Mastra workflow runs the full 6-phase pipeline (prefetch → anomaly →
 * planning → [metrics | logs | infra] → synthesis → post-synthesis) and maps
 * its output to an RcaReport.
 *
 * Phase progress callbacks (onPhase, onIteration) emit approximate progress
 * events so the frontend progress UI keeps working.
 */
export class MastraInvestigationAdapter {
  private workflowConfig: WorkflowConfig;

  constructor(workflowConfig: WorkflowConfig) {
    this.workflowConfig = workflowConfig;
  }

  async investigate(
    service: ServiceConfig,
    _initialAnomaly: unknown,
    _correlationId?: string,
    onTokenUsage?: (usage: TokenUsage) => void,
    userMessage?: string,
    _onToolCall?: OnToolCallEnriched,
    onPhase?: (phase: string) => void,
    onIteration?: OnIteration,
    skillContext?: string,
    template?: InvestigationTemplate,
    readOnlyTools?: boolean,
    skills?: import("../skills/store.js").Skill[],
  ): Promise<RcaReport> {
    const workflowConfig: WorkflowConfig = {
      ...this.workflowConfig,
      // Put the target service first so the post-synthesis step can reference it
      services: [service, ...this.workflowConfig.services.filter(s => s.name !== service.name)],
      // Wire progress callbacks through to the workflow steps
      onPhase,
      onIteration,
      onToolCall: _onToolCall,
      onTokenUsage,
      // Security: headless investigations are locked to read-only tools
      readOnlyTools,
      // Pre-filtered investigation-scoped skills
      skills,
    };

    const workflow = createInvestigationWorkflow(workflowConfig, template);

    let output: {
      severity: "low" | "medium" | "high" | "critical";
      summary: string;
      impact: { duration: string; description: string };
      rootCause: string;
      trigger: string;
      contributingFactors: string[];
      timeline: Array<{ time: string; event: string }>;
      evidence: { metrics: string[]; logs: string[]; infra: string[] };
      dashboardLinks: string[];
      recommendedActions: string[];
      confidence: "low" | "medium" | "high";
      confidenceScore: number;
      savedToHistory: boolean;
      investigatedAt: string;
      timeRange?: { from: string; to: string };
      evidenceToolCalls?: Record<string, Array<{ tool: string; args: string; resultChars: number; resultExcerpt?: string }>>;
      hypotheses?: Array<{ hypothesis: string; prediction: Record<string, unknown> }>;
      ruledOut?: Array<{ hypothesis: string; reason: string }>;
      loopOutcome?: "confirmed" | "undetermined" | "exhausted";
    } | undefined;

    // createRun() returns a Promise<Run>, then we call .start() on the Run
    const run = await workflow.createRun();

    const runResult = await run.start({
      inputData: {
        userMessage: userMessage ?? `Investigate ${service.name}`,
        serviceName: service.name,
        skillContext,
      },
    });

    if (runResult.status === "success") {
      output = runResult.result as typeof output;
    } else {
      // Workflow failed — Mastra absorbs step throws into runResult.steps.<id>.error.
      // If any step failed with LlmUnavailableError, propagate it so the runner's
      // catch marks the investigation `failed` instead of persisting an empty RCA.
      const stepErrors: unknown[] = [];
      const result = runResult as { error?: unknown; steps?: Record<string, { error?: unknown; status?: string }> };
      if (result.error) stepErrors.push(result.error);
      for (const stepResult of Object.values(result.steps ?? {})) {
        if (stepResult?.status === "failed" && stepResult.error) {
          stepErrors.push(stepResult.error);
        }
      }
      const llmUnavailable = stepErrors.find((e) => e instanceof LlmUnavailableError);
      if (llmUnavailable) throw llmUnavailable;
    }

    // Map the workflow output to the RcaReport shape the server/CLI expect
    const investigatedAt = output?.investigatedAt ?? new Date().toISOString();

    const report: RcaReport = {
      service: service.name,
      severity: output?.severity ?? "medium",
      summary: output?.summary ?? "Investigation complete",
      impact: output?.impact ?? { duration: "Unknown", description: output?.summary ?? "" },
      rootCause: output?.rootCause ?? "Unable to determine root cause",
      trigger: output?.trigger ?? "Unknown",
      contributingFactors: output?.contributingFactors ?? [],
      timeline: output?.timeline ?? [],
      evidence: output?.evidence ?? { metrics: [], logs: [], infra: [] },
      dashboardLinks: output?.dashboardLinks ?? [],
      recommendedActions: output?.recommendedActions ?? [],
      confidence: output?.confidence ?? "low",
      confidenceScore: output?.confidenceScore ?? 0.5,
      investigatedAt,
      timeRange: output?.timeRange,
      evidenceToolCalls: output?.evidenceToolCalls,
      hypotheses: output?.hypotheses,
      ruledOut: output?.ruledOut,
      loopOutcome: output?.loopOutcome,
    };

    return report;
  }
}

// ── DiscoverAgent adapter ─────────────────────────────────────────────────────

export interface MastraDiscoverAdapterDeps {
  model: LanguageModel;
  providers: MastraProvider[];
  discoveryConfig: DiscoveryConfig;
  registryStore: ServiceRegistryStore;
  /** Retry config for transient LLM-call failures. */
  llmRetry?: LlmRetryConfig;
  /** Per-attempt LLM call timeout — bounds silent-stall hangs in the discover agent. */
  llmCallMs?: number;
}

export class MastraDiscoverAdapter implements IDiscoverAgent {
  private deps: MastraDiscoverAdapterDeps;

  constructor(deps: MastraDiscoverAdapterDeps) {
    this.deps = deps;
  }

  async discover(
    config: DiscoveryConfig,
    options: DiscoverOptions = {},
  ): Promise<DiscoveryResult> {
    return runDiscovery({
      model: this.deps.model,
      providers: this.deps.providers,
      discoveryConfig: config,
      onPhase: options.onPhase,
      onIteration: options.onIteration,
      onToolCall: options.onToolCall,
      onTokenUsage: options.onTokenUsage,
      skills: options.skills,
      onRetry: options.onRetry,
      abortSignal: options.abortSignal,
      llmRetry: this.deps.llmRetry,
      llmCallMs: this.deps.llmCallMs,
    });
  }

  async accept(
    services: ServiceConfig[],
    source: "discovery" | "manual",
    globalProbeRules?: ProbeMetricRule[],
  ): Promise<string> {
    // When discovery writes globals, persist both atomically via saveAll()
    // — one version history entry, no mid-write state where a concurrent
    // probe tick could read services from one save and globals from
    // another. When globals are absent (manual UI edit, CLI rename,
    // rollback), fall through to save() which internally preserves the
    // file's current globals so they can never be silently clobbered.
    if (globalProbeRules !== undefined) {
      return this.deps.registryStore.saveAll(
        { services, globalProbeRules },
        source,
      );
    }
    return this.deps.registryStore.save(services, source);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface MastraAdapterDeps {
  config: Config;
  providers: MastraProvider[];
  noHistory?: boolean;
  registryStore?: ServiceRegistryStore;
  /**
   * Pair `db` + `stackId` to enable learned-pattern injection into planner
   * and synthesis prompts. The adapter binds them into a stack-scoped
   * `getSimilarPatterns(service)` closure on workflowConfig. Optional —
   * omit on CLI / test paths that don't have a database.
   */
  db?: import("./db.js").Database;
  stackId?: string;
}

/**
 * Build MastraChatAgentAdapter and MastraInvestigationAdapter from application
 * config and Mastra MCP providers.
 *
 * Called once at server/CLI startup when USE_MASTRA=true.
 */
export async function createMastraAdapters(deps: MastraAdapterDeps) {
  const { config, providers } = deps;

  // Per-bucket reasoning effort: when the call site provides db + stackId we
  // resolve per-stack overrides; otherwise we fall back to a single model
  // (config defaults still apply via the resolver). Three models in flight is
  // intentional — chat, investigation, and discovery can each be tuned
  // independently from Settings → LLM.
  const buildModel = (bucket: "chat" | "investigation" | "discovery") => {
    if (deps.db && deps.stackId) {
      const effort = getEffectiveReasoningEffort(deps.db, config, deps.stackId, bucket);
      return createModel(config.llm, effort ? { reasoningEffort: effort } : {});
    }
    const fallback = config.llm.reasoningEffort?.[bucket] ?? config.llm.reasoningEffort?.default;
    return createModel(config.llm, fallback ? { reasoningEffort: fallback } : {});
  };
  const chatModel = buildModel("chat");
  const investigationModel = buildModel("investigation");
  const discoveryModel = buildModel("discovery");

  // Web chat renders charts inline from metrics data. CLI still needs panel-image tools.
  // Exclude tools whose descriptions indicate they produce images/screenshots/rendered panels.
  // Also apply coerceLokiArgs to Loki tools so chat follow-ups get direction:backward + limit>=50.
  const allTools = await getAllTools(providers).catch(() => ({}));
  const inlineChartTools: Record<string, any> = {};
  for (const [name, tool] of Object.entries(allTools)) {
    const desc = ((tool as any).description ?? "").toLowerCase();
    const isImageTool =
      desc.includes("image") &&
      (desc.includes("panel") ||
        desc.includes("render") ||
        desc.includes("screenshot"));
    if (!isImageTool) {
      // Wrap Loki log query tools with parameter coercion + result truncation.
      // Coercion: direction:backward + limit>=50 (same fix as investigation agents).
      // Truncation: cap result to 10K chars so the chat context doesn't exceed the
      // backend's limit when the full Loki response (33K+) is fed back to the LLM.
      if (name.includes("query_loki_logs")) {
        inlineChartTools[name] = {
          ...tool,
          execute: async (...args: any[]) => {
            if (args[0] && typeof args[0] === "object") {
              args[0] = coerceLokiArgs(args[0] as Record<string, unknown>);
            }
            const result = await (tool as any).execute(...args);
            return truncateMcpResult(result, 20_000);
          },
        };
      } else {
        inlineChartTools[name] = tool;
      }
    }
  }

  const chatAgent = new MastraChatAgentAdapter(
    {
      inlineCharts: createChatAgent({
        agentId: "chat-inline",
        model: chatModel,
        tools: inlineChartTools,
        maxSteps: config.agent.maxIterations,
        supportsInlineCharts: true,
      }),
      imageAttachments: createChatAgent({
        agentId: "chat-attachments",
        model: chatModel,
        tools: allTools,
        maxSteps: config.agent.maxIterations,
        supportsInlineCharts: false,
      }),
    },
    { llmCallMs: config.timeouts?.llmCallMs },
  );

  const { db, stackId } = deps;
  const workflowConfig: WorkflowConfig = {
    model: investigationModel,
    providers,
    services: config.services,
    projectRoot: deps.noHistory ? undefined : process.cwd(),
    useQuirkHandling: true,
    maxCharsPerSkill: config.skills?.maxCharsPerSkill,
    getSimilarPatterns: db && stackId
      ? (service, limit = 5) => db.findSimilarPatterns(stackId, service, limit)
      : undefined,
    llmRetry: config.llm.retry,
    synthesisLoopRounds: config.agent?.synthesisLoopRounds,
  };

  const investigationAgent = new MastraInvestigationAdapter(workflowConfig);

  /**
   * Deep mode (Step 3): re-examine a completed investigation's ruled-out
   * hypotheses with deeper read-only re-queries, resurrecting any the loop
   * dismissed on thin evidence. Reuses the investigation providers + model
   * wired above (no duplication). Returns a serializable DeepModeReport the
   * caller persists onto the stored RcaReport. Read-only throughout.
   */
  async function deepModeReexamine(
    report: RcaReport,
    opts?: { onStep?: (ev: Omit<AgentStreamEvent, "seq">) => void; maxReexamine?: number },
  ): Promise<DeepModeReport> {
    const step = opts?.onStep ?? (() => {});
    const examinedAt = new Date().toISOString();
    const maxReexamine = opts?.maxReexamine ?? 3;
    // Resurrect ruled-out causes, or — when none were ruled out — skeptically
    // re-test the loop's standing conclusion (refute the confirmed cause).
    const targets = buildReexamineTargets(report.hypotheses ?? [], report.ruledOut ?? [], report.loopOutcome, maxReexamine);
    if (targets.length === 0) {
      return { reexamined: [], resurrected: [], shaken: [], outcome: "nothing-to-examine", examinedAt };
    }
    const mode = targets[0].priorStanding === "ruled-out" ? "resurrect" : "refute";
    // Translate raw MCP tool names into plain English for the stream.
    const friendlyTool = (t: string): string => {
      const k = t.toLowerCase();
      if (k.includes("event")) return "cluster events";
      if (k.includes("prometheus") || k.includes("metric")) return "metrics";
      if (k.includes("loki") || k.includes("log")) return "logs";
      if (k.includes("pod")) return "pods";
      if (k.includes("deployment")) return "deployments";
      if (k.includes("datasource")) return "data sources";
      return t.replace(/_/g, " ");
    };
    step(mode === "resurrect"
      ? { verb: "reopening", target: `${targets.length} dismissed ${targets.length === 1 ? "cause" : "causes"}`, status: "running" }
      : { verb: "double-checking", target: "the most likely cause", detail: "(nothing was ruled out, so re-testing what we confirmed)", status: "running" });
    const timeRange = report.timeRange;
    // Dig deeper than the loop did: re-query a BROADER window so precursors the
    // narrow incident window missed can surface. The change-in-window predicate
    // still anchors to the ORIGINAL incident onset (ctx.incidentTime), so a
    // wider query window doesn't move what counts as "before the incident".
    const deeperRange = widenTimeRange(timeRange);
    const ctx = { incidentTime: timeRange?.from };
    const gather = createGatherEvidence({
      providers,
      model: investigationModel,
      timeRange: deeperRange,
      useQuirkHandling: true,
      onToolCall: (tool, _args, _result, _dur, error) =>
        step({ verb: "looked at", target: friendlyTool(tool), targetKind: "query", status: error ? "rejected" : "done", indent: 1 }),
      llmRetry: config.llm.retry,
      ctx,
    });
    const result = await runDeepMode({
      targets,
      priorObservations: [],
      maxReexamine,
      gatherDeepEvidence: (h) => {
        step({ verb: mode === "resurrect" ? "checking" : "re-checking", target: h.hypothesis, status: "running" });
        return gather(h, 1);
      },
      ctx,
    });
    // Per-hypothesis verdicts are known only after the loop finishes.
    for (const r of result.reexamined) {
      if (r.priorStanding === "ruled-out") {
        step(r.flipped
          ? { verb: "Worth another look:", target: r.hypothesis, detail: "— deeper evidence now points to it", status: "strong" }
          : { verb: "Still unlikely:", target: r.hypothesis, detail: "— deeper evidence still doesn't support it", status: "done" });
      } else {
        step(r.flipped
          ? { verb: "Probably not the cause:", target: r.hypothesis, detail: "— the evidence that would confirm it isn't there", status: "rejected" }
          : { verb: "Still the likely cause:", target: r.hypothesis, detail: "— deeper evidence backs it up", status: "strong" });
      }
    }
    const toRef = (h: { hypothesis: string; prediction: unknown }) => ({ hypothesis: h.hypothesis, prediction: h.prediction as Record<string, unknown> });
    return {
      reexamined: result.reexamined.map((r) => ({
        hypothesis: r.hypothesis,
        priorStanding: r.priorStanding,
        priorVerdict: r.priorVerdict,
        deepVerdict: r.deepVerdict,
        flipped: r.flipped,
      })),
      resurrected: result.resurrected.map(toRef),
      shaken: result.shaken.map(toRef),
      outcome: result.outcome,
      examinedAt,
    };
  }

  const discoverAgent = deps.registryStore
    ? new MastraDiscoverAdapter({
        model: discoveryModel,
        providers,
        discoveryConfig: config.discovery,
        registryStore: deps.registryStore,
        llmRetry: config.llm.retry,
        llmCallMs: config.timeouts?.llmCallMs,
      })
    : undefined;

  /**
   * Autonomous orchestrator (Approach D): run the unbounded read-only move-loop
   * for `focus`, reusing the investigation providers + model wired above. The
   * core's TraceEntry stream is mapped to AgentStreamEvent for the UI. Read-only
   * throughout (gather forces read-only tools); guarded by the safety harness.
   */
  async function orchestrate(
    focus: string,
    opts?: {
      timeRange?: { from: string; to: string };
      ctx?: CorroborationContext;
      onStep?: (ev: Omit<AgentStreamEvent, "seq">) => void;
      guards?: Partial<OrchestratorGuards>;
      /** Incident service's dependency neighbors (resolved by the caller). */
      dependencies?: string[];
      /** The incident service itself (for the cross-service confirm guard). */
      incidentService?: string;
      /** All known service names — the cross-service guard checks these too. */
      knownServices?: string[];
      /** Interactive operator-pause hook (increment 5). Wired by the WS layer to
       *  the pause card; absent → the strike limit stops directly. PR-4: resolves
       *  to `{ decision, context? }` where `context` is the operator's free-text lead. */
      onOperatorPause?: (
        state: OrchestratorState,
      ) => Promise<{ decision: "continue" | "escalate" | "wait"; context?: string }>;
      /** Cooperative abort — the WS layer aborts on a deliberate operator Stop. */
      signal?: AbortSignal;
      /** Move-boundary hook (PR-2c) — the WS layer parks a viewerless run. */
      onMoveBoundary?: () => Promise<void> | void;
      /** Follow a lead: an optional operator hunch that seeds the run from move 1. */
      lead?: string;
      /** Team-knowledge skills (formatted) for the decide-move system prompt. */
      skillContext?: string;
      /** Pre-filtered team-knowledge skills for spawned sub-investigations. */
      skills?: Skill[];
    },
  ): Promise<OrchestratorResult> {
    const guards: OrchestratorGuards = { ...DEFAULT_ORCHESTRATOR_GUARDS, ...opts?.guards };
    const onStep = opts?.onStep;
    // Depth-1 subagent: a scoped, read-only sub-investigation on a related
    // service. Its conclusion folds back as one observation the orchestrator can
    // test against. Read-only (readOnlyTools=true); failures degrade to no
    // findings so a bad subagent never aborts the parent run. Subagent token
    // usage is bounded by maxSubagents + wall-clock (not the token budget) in v1.
    const spawnSubagent = async (
      args: { service: string; question: string },
    ): Promise<NormalizedObservation[]> => {
      const svc: ServiceConfig =
        config.services.find((s) => s.name === args.service) ?? { name: args.service, metrics: [], logLabels: {}, probeRules: [] };
      try {
        const report = await investigationAgent.investigate(
          // "quick" (metrics-only) keeps a subagent ~1 min instead of the 2-3 min
          // a "standard" run costs — an autonomous run can spawn several, so the
          // cheaper template matters. Revisit if subagents miss log-based causes.
          svc, null, undefined, undefined, args.question,
          undefined, undefined, undefined, opts?.skillContext, "quick", true, opts?.skills,
        );
        const rc =
          report.rootCause && !/^under investigation$|^unable to determine/i.test(report.rootCause.trim())
            ? report.rootCause
            : "";
        const text = [rc, report.summary].filter(Boolean).join(" — ").slice(0, 300);
        return text ? [{ phase: "infra", subject: args.service, text: `subagent: ${text}` }] : [];
      } catch {
        return [];
      }
    };
    return runAutonomousOrchestrator({
      focus,
      model: investigationModel,
      providers,
      guards,
      timeRange: opts?.timeRange,
      ctx: opts?.ctx,
      llmRetry: config.llm.retry,
      llmCallMs: config.timeouts?.llmCallMs,
      onStep: onStep ? (entry) => onStep(traceEntryToStreamEvent(entry)) : undefined,
      spawnSubagent,
      dependencies: opts?.dependencies,
      incidentService: opts?.incidentService,
      knownServices: opts?.knownServices,
      onOperatorPause: opts?.onOperatorPause,
      signal: opts?.signal,
      onMoveBoundary: opts?.onMoveBoundary,
      initialLead: opts?.lead,
      skillContext: opts?.skillContext,
    });
  }

  /**
   * Re-synthesis for operator-accept (PR-6b): regenerate an RCA report's narrative
   * to fit a confirmed autonomous cause, reusing the investigation model. Returns
   * the new prose fields, or null on any LLM failure (caller falls back to the
   * field-merge so Apply never breaks).
   */
  async function refineReport(report: RcaReport, input: RefineInput): Promise<RefinedNarrative | null> {
    return refineReportFromDeepRun(report, input, {
      model: investigationModel,
      llmRetry: config.llm.retry,
      llmCallMs: config.timeouts?.llmCallMs,
    });
  }

  return { chatAgent, investigationAgent, discoverAgent, deepModeReexamine, orchestrate, refineReport };
}

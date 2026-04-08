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
import type { RcaReport } from "../types/rca-types.js";
import type { IDiscoverAgent, OnToolCallEnriched, OnIteration } from "../types/agent-interfaces.js";
import type { InvestigationTemplate } from "../config/schema.js";
import type { ChatRequest, ChatResponse, ImageAttachment } from "../types/agent-types.js";
import type { TokenUsage } from "../types/llm-types.js";
import type { ValidatedServiceConfig } from "../types/discovery-types.js";
import { createChatAgent } from "../agents/chat.js";
import { wrapUntrusted } from "../agents/shared/prompt-helpers.js";
import { logLlmCall, logToolCall, newCallId, type ToolCallEvent } from "./llm-logger.js";
import { createInvestigationWorkflow, type WorkflowConfig } from "../workflows/investigation.js";
import { runDiscovery } from "../workflows/discovery.js";
import { createModel } from "../mastra/index.js";
import type { Config } from "../config/schema.js";
import type { MastraProvider } from "../mcp/provider.js";
import { getAllTools } from "../mcp/provider.js";
import { coerceLokiArgs } from "../workflows/tool-utils.js";
import type { ServiceRegistryStore } from "../services/registry.js";
import type { LanguageModel } from "ai";

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
function truncateMcpResult(result: unknown, maxChars: number): unknown {
  if (!result || typeof result !== "object") return result;
  const content = (result as any).content;
  if (!Array.isArray(content)) return result;
  const truncated = content.map((part: any) => {
    if (part?.type === "text" && typeof part.text === "string" && part.text.length > maxChars) {
      return { ...part, text: part.text.slice(0, maxChars) + `\n... (truncated from ${part.text.length} chars)` };
    }
    return part;
  });
  return { ...result, content: truncated };
}

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

  constructor(mastraAgents: MastraChatAgentSet) {
    this.mastraAgents = mastraAgents;
  }

  async chat(task: ChatRequest): Promise<ChatResponse> {
    const mastraAgent = selectChatAgent(this.mastraAgents, task);
    const prompt = buildHistoryContext(task);
    const streamInput = prompt as MastraStreamInput;
    const collectedImages: ImageAttachment[] = [];

    // Signal streaming start immediately so UI shows "Thinking..."
    task.onStreamStart?.();

    let responseText = "";
    const chatCallId = newCallId();
    const chatToolCalls: ToolCallEvent[] = [];
    let chatInputTokens = 0;
    let chatOutputTokens = 0;
    const chatStartMs = Date.now();
    try {
      const stream = await mastraAgent.stream(streamInput);

      for await (const chunk of stream.fullStream) {
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
          chatToolCalls.push({ tool: toolName, argsChars: 0, resultChars: resultStr.length, result: resultStr.slice(0, 500) });
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
      console.error("[MASTRA_CHAT] stream error:", err);
      if (!responseText) {
        try {
          const result = await mastraAgent.generate(prompt);
          responseText = result.text ?? "";
          task.onStreamDelta?.({ type: "content", content: responseText });
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
}

export class MastraDiscoverAdapter implements IDiscoverAgent {
  private deps: MastraDiscoverAdapterDeps;

  constructor(deps: MastraDiscoverAdapterDeps) {
    this.deps = deps;
  }

  async discover(
    config: DiscoveryConfig,
    onPhase?: (phase: string) => void,
    onIteration?: OnIteration,
    onToolCall?: OnToolCallEnriched,
    onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
    skills?: import("../skills/store.js").Skill[],
  ): Promise<ValidatedServiceConfig[]> {
    return runDiscovery({
      model: this.deps.model,
      providers: this.deps.providers,
      discoveryConfig: config,
      onPhase,
      onIteration,
      onToolCall,
      onTokenUsage,
      skills,
    });
  }

  async accept(services: ServiceConfig[], source: "discovery" | "manual"): Promise<string> {
    return this.deps.registryStore.save(services, source);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface MastraAdapterDeps {
  config: Config;
  providers: MastraProvider[];
  noHistory?: boolean;
  registryStore?: ServiceRegistryStore;
}

/**
 * Build MastraChatAgentAdapter and MastraInvestigationAdapter from application
 * config and Mastra MCP providers.
 *
 * Called once at server/CLI startup when USE_MASTRA=true.
 */
export async function createMastraAdapters(deps: MastraAdapterDeps) {
  const { config, providers } = deps;
  const model = createModel(config.llm);

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
        model,
        tools: inlineChartTools,
        maxSteps: config.agent.maxIterations,
        supportsInlineCharts: true,
      }),
      imageAttachments: createChatAgent({
        agentId: "chat-attachments",
        model,
        tools: allTools,
        maxSteps: config.agent.maxIterations,
        supportsInlineCharts: false,
      }),
    },
  );

  const workflowConfig: WorkflowConfig = {
    model,
    providers,
    services: config.services,
    projectRoot: deps.noHistory ? undefined : process.cwd(),
    useQuirkHandling: true, // Enable wind-down: disables tools on last 2 iterations to force text output
    maxCharsPerSkill: config.skills?.maxCharsPerSkill,
  };

  const investigationAgent = new MastraInvestigationAdapter(workflowConfig);

  const discoverAgent = deps.registryStore
    ? new MastraDiscoverAdapter({
        model,
        providers,
        discoveryConfig: config.discovery,
        registryStore: deps.registryStore,
      })
    : undefined;

  return { chatAgent, investigationAgent, discoverAgent };
}

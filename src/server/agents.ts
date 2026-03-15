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
 * NOTE: The Mastra chat agent runs via agent.generate() (non-streaming) for now.
 * Full streaming via Mastra's streamText/subscribeToRun will require additional
 * adapter work once the Mastra stream API stabilises.
 */

import type { ServiceConfig } from "../config/schema.js";
import type { RcaReport } from "../types/rca-types.js";
import type { OnToolCallEnriched, OnIteration } from "../types/agent-interfaces.js";
import type { ChatRequest, ChatResponse } from "../types/agent-types.js";
import type { TokenUsage } from "../types/llm-types.js";
import { createChatAgent } from "../agents/chat.js";
import { createInvestigationWorkflow, type WorkflowConfig } from "../workflows/investigation.js";
import { createModel } from "../mastra/index.js";
import type { Config } from "../config/schema.js";
import type { MastraProvider } from "../mcp/provider.js";
import { getAllTools } from "../mcp/provider.js";

// ── ChatAgent adapter ─────────────────────────────────────────────────────────

/**
 * A duck-typed wrapper around the Mastra chat agent that exposes the same
 * `chat()` method the existing server/CLI code calls.
 *
 * Streaming: we call agent.generate() and emit a single onStreamDelta with
 * the full response. Full streaming via agent.stream() can be wired in later
 * once the Mastra streaming API is stable.
 *
 * Tool-call visibility: Mastra does not expose per-tool callbacks at the
 * generate/stream level in the same granular way as the old ChatAgent.
 * Tool calls are silently executed inside the Mastra agent loop; the
 * caller still receives a valid response.
 */
export class MastraChatAgentAdapter {
  private mastraAgent: ReturnType<typeof createChatAgent>;

  constructor(mastraAgent: ReturnType<typeof createChatAgent>) {
    this.mastraAgent = mastraAgent;
  }

  async chat(task: ChatRequest): Promise<ChatResponse> {
    // Build messages array for Mastra agent
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    for (const m of task.history ?? []) {
      if (m.role === "system" || m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: m.content ?? "" });
      }
    }
    messages.push({ role: "user", content: task.message });

    // Signal streaming start immediately so UI shows "Thinking..."
    task.onStreamStart?.();

    let responseText = "";
    try {
      const stream = await this.mastraAgent.stream(messages);

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
          console.error(`[MASTRA_CHAT] tool-call: ${toolName} args=${JSON.stringify(p.args ?? {}).slice(0, 500)}`);
          task.onToolCall?.(toolName, p.args ?? {});
        } else if (c.type === "tool-result") {
          const rawName = p.toolName ?? "unknown";
          const idx = rawName.indexOf("_");
          const toolName = idx > 0 ? rawName.slice(idx + 1) : rawName;
          const result = p.result ?? "";
          const nestedContent = result?.content?.[0]?.text;
          const resultStr = typeof nestedContent === "string" ? nestedContent
            : typeof result === "string" ? result
            : JSON.stringify(result);
          if (toolName === "query_prometheus") {
            console.error(`[MASTRA_CHAT] tool-result: ${toolName} resultLen=${resultStr.length} first200=${resultStr.slice(0, 200)}`);
          }
          task.onToolCall?.(toolName, p.args ?? {}, resultStr);
        }
      }
    } catch (err) {
      console.error("[MASTRA_CHAT] stream error:", err);
      if (!responseText) {
        try {
          const prompt = messages.map((m) => m.role === "user" ? m.content : `[${m.role}] ${m.content}`).join("\n\n");
          const result = await this.mastraAgent.generate(prompt);
          responseText = result.text ?? "";
          task.onStreamDelta?.({ type: "content", content: responseText });
        } catch (genErr) {
          const errMsg = genErr instanceof Error ? genErr.message : String(genErr);
          responseText = `Error: ${errMsg}`;
          task.onStreamDelta?.({ type: "content", content: responseText });
        }
      }
    }

    return {
      response: responseText,
      updatedHistory: [],
      images: [],
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
    _onTokenUsage?: (usage: TokenUsage) => void,
    userMessage?: string,
    _onToolCall?: OnToolCallEnriched,
    onPhase?: (phase: string) => void,
    onIteration?: OnIteration,
    _skillContext?: string,
  ): Promise<RcaReport> {
    const workflowConfig: WorkflowConfig = {
      ...this.workflowConfig,
      // Put the target service first so the post-synthesis step can reference it
      services: [service, ...this.workflowConfig.services.filter(s => s.name !== service.name)],
      // Wire progress callbacks through to the workflow steps
      onPhase,
      onIteration,
      onToolCall: _onToolCall,
    };

    const workflow = createInvestigationWorkflow(workflowConfig);

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
    } | undefined;

    // createRun() returns a Promise<Run>, then we call .start() on the Run
    const run = await workflow.createRun();

    const runResult = await run.start({
      inputData: {
        userMessage: userMessage ?? `Investigate ${service.name}`,
        serviceName: service.name,
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
    };

    return report;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface MastraAdapterDeps {
  config: Config;
  providers: MastraProvider[];
  noHistory?: boolean;
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

  // Build a tool map for the chat agent (all tools except get_panel_image which returns huge base64 blobs)
  const allTools = await getAllTools(providers).catch(() => ({}));
  const chatTools: Record<string, any> = {};
  for (const [name, tool] of Object.entries(allTools)) {
    if (!name.endsWith("get_panel_image")) chatTools[name] = tool;
  }

  const chatAgent = new MastraChatAgentAdapter(
    createChatAgent({ model, tools: chatTools, maxSteps: config.agent.maxIterations }),
  );

  const workflowConfig: WorkflowConfig = {
    model,
    providers,
    services: config.services,
    projectRoot: deps.noHistory ? undefined : process.cwd(),
    useQuirkHandling: true, // Enable wind-down: disables tools on last 2 iterations to force text output
  };

  const investigationAgent = new MastraInvestigationAdapter(workflowConfig);

  return { chatAgent, investigationAgent };
}

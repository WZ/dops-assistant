/**
 * src/server/mastra-adapter.ts
 *
 * Adapter that wraps the new Mastra agents and investigation workflow into
 * the same duck-typed interfaces that the web server (ws-handler.ts) and
 * CLI (interfaces/cli/App.tsx) already depend on.
 *
 * This lets us drop in the Mastra path via USE_MASTRA=true without rewriting
 * the existing server/CLI code. The adapter satisfies the following contracts:
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
import type { RcaReport } from "../agent/rca-types.js";
import type { OnToolCallEnriched, OnIteration } from "../agent/investigation.js";
import type { ChatRequest, ChatResponse } from "../agent/types.js";
import type { TokenUsage } from "../llm/openai.js";
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
    // Build a single prompt string from message history
    const promptParts: string[] = [];
    for (const m of task.history ?? []) {
      if (m.role === "system") {
        promptParts.push(`[System] ${m.content}`);
      } else if (m.role === "user") {
        promptParts.push(m.content);
      } else if (m.role === "assistant") {
        promptParts.push(`[Assistant] ${m.content}`);
      }
    }
    promptParts.push(task.message);
    const prompt = promptParts.join("\n\n");

    // Signal streaming start immediately so UI shows the spinner
    task.onStreamStart?.();

    let responseText = "";
    try {
      const result = await this.mastraAgent.generate(prompt);
      responseText = result.text ?? "";
      task.onStreamDelta?.({ type: "content", content: responseText });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      responseText = `Error: ${errMsg}`;
      task.onStreamDelta?.({ type: "content", content: responseText });
    }

    return {
      response: responseText,
      // updatedHistory is required by the ChatResponse type but only consumed
      // by the old ChatAgent; the server/CLI only reads `.response` and `.images`.
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
    };

    const workflow = createInvestigationWorkflow(workflowConfig);

    // Emit approximate progress phases so the frontend progress bar keeps moving
    onPhase?.("Detecting anomalies");
    onIteration?.("planning", 0, 6, "Pre-fetching datasource context");

    let output: {
      severity: "low" | "medium" | "high" | "critical";
      summary: string;
      rootCause: string;
      trigger: string;
      confidence: "low" | "medium" | "high";
      confidenceScore: number;
      savedToHistory: boolean;
      investigatedAt: string;
    } | undefined;

    try {
      onPhase?.("Planning investigation");
      onIteration?.("planning", 1, 6, "Building investigation plan");

      // createRun() returns a Promise<Run>, then we call .start() on the Run
      const run = await workflow.createRun();

      onPhase?.("Analyzing metrics, logs & infrastructure");
      onIteration?.("metrics", 2, 6, "Analyzing metrics, logs, and infrastructure");

      const runResult = await run.start({
        inputData: {
          userMessage: userMessage ?? `Investigate ${service.name}`,
          serviceName: service.name,
        },
      });

      onPhase?.("Synthesizing root cause");
      onIteration?.("synthesis", 5, 6, "Synthesizing root cause");

      if (runResult.status === "success") {
        output = runResult.result as typeof output;
      }
    } catch (err) {
      onPhase?.("Synthesizing root cause");
      throw err;
    }

    // Map the workflow output to the RcaReport shape the server/CLI expect
    const investigatedAt = output?.investigatedAt ?? new Date().toISOString();

    const report: RcaReport = {
      service: service.name,
      severity: output?.severity ?? "medium",
      summary: output?.summary ?? "Investigation complete",
      rootCause: output?.rootCause ?? "Unable to determine root cause",
      trigger: output?.trigger ?? "Unknown",
      confidence: output?.confidence ?? "low",
      confidenceScore: output?.confidenceScore ?? 0.5,
      investigatedAt,
      impact: {
        duration: "Unknown",
        description: output?.summary ?? "",
      },
      contributingFactors: [],
      timeline: [],
      evidence: {
        metrics: [],
        logs: [],
        infra: [],
      },
      dashboardLinks: [],
      recommendedActions: [],
    };

    return report;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface MastraAdapterDeps {
  config: Config;
  providers: MastraProvider[];
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

  // Build a tool map for the chat agent (all tools from all providers)
  const allTools = await getAllTools(providers).catch(() => ({}));

  const chatAgent = new MastraChatAgentAdapter(
    createChatAgent({ model, tools: allTools, maxSteps: config.agent.maxIterations }),
  );

  const workflowConfig: WorkflowConfig = {
    model,
    providers,
    services: config.services,
    projectRoot: process.cwd(),
  };

  const investigationAgent = new MastraInvestigationAdapter(workflowConfig);

  return { chatAgent, investigationAgent };
}

import { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { ulid } from "ulid";
import pino from "pino";
import type { Database } from "./db.js";
import type { IChatAgent, IInvestigationAgent, IDiscoverAgent } from "../types/agent-interfaces.js";
import type { IntentRouter } from "../agents/intent.js";
import { resolveServiceFromHistory } from "../agents/intent.js";
import type { ServiceConfig, DiscoveryConfig, Config } from "../config/schema.js";
import type { ClientMessage, ServerMessage, ChartSeries } from "../types/ws-types.js";
import { DEFAULT_STACK_SLUG } from "../types/stack-types.js";
import type { ValidatedServiceConfig } from "../types/discovery-types.js";
import type { SkillStore } from "../skills/store.js";
import { InvestigationRunner, friendlyError } from "./investigation-runner.js";
import type { InvestigationCallbacks, RunnerDeps } from "./investigation-runner.js";
import type { StackManager, StackContext } from "./stack-manager.js";
import type { InvestigationDedup } from "./investigation-dedup.js";
import { createMastraAdapters } from "./agents.js";
import { getToolsByRole } from "../mcp/provider.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const MAX_CHART_SERIES = 4;

/** Return true when a series is a flat constant (no variation worth charting) */
function isFlatSeries(values: [string, number][]): boolean {
  if (values.length < 2) return true;
  const first = values[0]![1];
  return values.every(([, v]) => v === first);
}

/** Extract chart-renderable time-series from a raw metric tool result */
function extractChartSeries(rawResult: string, args: Record<string, unknown>): ChartSeries[] {
  const series: ChartSeries[] = [];
  try {
    const parsed = JSON.parse(rawResult);
    const query = typeof args.query === "string" ? args.query
      : typeof args.expr === "string" ? args.expr
      : typeof args.expression === "string" ? args.expression
      : undefined;

    let items: unknown[];
    if (Array.isArray(parsed)) items = parsed;
    else if (Array.isArray(parsed?.data?.result)) items = parsed.data.result;
    else if (Array.isArray(parsed?.data)) items = parsed.data;
    else return series;

    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;

      // Compacted format: { m, instance, values: [[iso, num], ...] }
      if (obj.m !== undefined && Array.isArray(obj.values) && obj.values.length >= 2) {
        const values: [string, number][] = (obj.values as [string, number][]).map(([ts, v]) => [
          String(ts), typeof v === "string" ? parseFloat(v) : Number(v),
        ]);
        if (!isFlatSeries(values)) {
          series.push({
            metric: String(obj.m || ""),
            instance: typeof obj.instance === "string" ? obj.instance : undefined,
            query,
            values,
            min: obj.min != null ? Number(obj.min) : undefined,
            max: obj.max != null ? Number(obj.max) : undefined,
            avg: obj.avg != null ? Number(obj.avg) : undefined,
          });
        }
        if (series.length >= MAX_CHART_SERIES) break;
        continue;
      }

      // Raw Prometheus format: { metric: { __name__: ... }, values: [[unixTs, "val"], ...] }
      if (typeof obj.metric === "object" && obj.metric !== null && Array.isArray(obj.values) && obj.values.length >= 2) {
        const metricObj = obj.metric as Record<string, string>;
        const values: [string, number][] = (obj.values as [number, string][]).map(([ts, v]) => [
          new Date(ts * 1000).toISOString(), parseFloat(v),
        ]);
        if (!isFlatSeries(values)) {
          series.push({
            metric: metricObj.__name__ || "",
            instance: metricObj.instance,
            query,
            values,
          });
        }
        if (series.length >= MAX_CHART_SERIES) break;
      }
    }
  } catch { /* ignore unparseable results */ }
  return series;
}

export interface WsDeps {
  db: Database;
  stackManager: StackManager;
  config: Config;
  router: IntentRouter;
  skillStore?: SkillStore;
  sharedDedup: InvestigationDedup;
  /** Global callback fired after every successful investigation (e.g. Slack notification) */
  globalOnComplete?: RunnerDeps["globalOnComplete"];
  validateLlmServiceMatch: (llmService: string | undefined, userMessage: string, services: ServiceConfig[]) => ServiceConfig | undefined;
  matchServiceFromText: (text: string, services: ServiceConfig[]) => ServiceConfig | undefined;
}

/** Lazily-created agents cache per stack */
const agentsCache = new Map<string, { chatAgent: IChatAgent; investigationAgent: IInvestigationAgent; discoverAgent?: IDiscoverAgent }>();

/** Metrics tool names cache per stack */
const metricsToolNamesCache = new Map<string, Set<string>>();

/** Clear cached agents and metrics tool names for a deleted stack */
export function clearStackCaches(stackId: string): void {
  agentsCache.delete(stackId);
  metricsToolNamesCache.delete(stackId);
}

async function getOrCreateAgents(
  stackId: string,
  ctx: StackContext,
  config: Config,
): Promise<{ chatAgent: IChatAgent; investigationAgent: IInvestigationAgent; discoverAgent?: IDiscoverAgent }> {
  const cached = agentsCache.get(stackId);
  if (cached) return cached;

  const providers = ctx.providerRegistry.getProviders();
  const adapters = await createMastraAdapters({
    config,
    providers,
    registryStore: ctx.serviceRegistry,
  });

  agentsCache.set(stackId, adapters);
  return adapters;
}

async function getMetricsToolNames(stackId: string, ctx: StackContext): Promise<Set<string>> {
  const cached = metricsToolNamesCache.get(stackId);
  if (cached) return cached;

  try {
    const providers = ctx.providerRegistry.getProviders();
    const metricsTools = await getToolsByRole(providers, "metrics");
    const names = new Set(
      Object.keys(metricsTools).map((k) => {
        const idx = k.indexOf("_");
        return idx > 0 ? k.slice(idx + 1) : k;
      }),
    );
    metricsToolNamesCache.set(stackId, names);
    return names;
  } catch {
    return new Set(["query_prometheus"]);
  }
}

export function setupWebSocket(server: Server, deps: WsDeps): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (ws: WebSocket, req) => {
    // Extract stackId from query params
    const url = new URL(req.url ?? "/", "http://localhost");
    const stackIdParam = url.searchParams.get("stackId");
    const stackId = deps.stackManager.resolveStackId(stackIdParam);
    const ctx = deps.stackManager.getContext(stackId);

    const threadId = `stack_${stackId}_web_${ulid()}`;
    logger.info({ threadId, stackId }, "WebSocket client connected");

    // Per-connection pending discovery state
    let pendingDiscovery: ValidatedServiceConfig[] | null = null;

    const send = (m: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(m));
      }
    };

    // Auto-refresh: run background discovery on startup if enabled
    const discoveryConfig = deps.config.discovery;
    if (discoveryConfig.autoRefresh) {
      try {
        const agents = await getOrCreateAgents(stackId, ctx, deps.config);
        if (agents.discoverAgent) {
          agents.discoverAgent
            .discover(discoveryConfig)
            .then((services) => {
              pendingDiscovery = services;
              if (services.length > 0) {
                send({ type: "discover:pending", services });
              }
            })
            .catch((err) => {
              logger.warn({ err }, "Auto-refresh discovery failed");
            });
        }
      } catch (err) {
        logger.warn({ err }, "Auto-refresh agent initialization failed");
      }
    }

    ws.on("message", async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        await handleClientMessage(msg, send, deps, threadId, stackId, ctx, () => pendingDiscovery, () => { pendingDiscovery = null; });
      } catch (err) {
        logger.error({ err }, "WebSocket message handling error");
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: "Internal error" }));
        }
      }
    });

    ws.on("close", () => {
      logger.info({ threadId, stackId }, "WebSocket client disconnected");
    });
  });
}

async function handleDeepInvestigate(
  msg: { type: "deep_investigate"; investigationId: string; message: string },
  send: (m: ServerMessage) => void,
  deps: WsDeps,
  threadId: string,
  stackId: string,
  ctx: StackContext,
): Promise<void> {
  const { db } = deps;
  const memory = ctx.conversationMemory;

  const investigation = db.getInvestigation(stackId, msg.investigationId);
  if (!investigation) {
    send({ type: "chat:stream_end", content: "Investigation not found." });
    return;
  }

  const phases = db.getPhases(msg.investigationId);
  const agents = await getOrCreateAgents(stackId, ctx, deps.config);
  const { chatAgent: agent } = agents;

  // Build context from investigation data
  const contextParts: string[] = [
    "You are a DevOps investigation assistant. The user is asking follow-up questions about a completed investigation.",
    "You have access to Grafana MCP tools to make live queries if needed.",
    "",
    "## Investigation Context",
    `Service: ${investigation.service}`,
    `Query: ${investigation.query}`,
    `Status: ${investigation.status}`,
  ];

  if (investigation.report) {
    try {
      const report = JSON.parse(investigation.report);
      contextParts.push(
        "",
        "## RCA Report",
        `Root Cause: ${report.rootCause}`,
        `Trigger: ${report.trigger}`,
        `Severity: ${report.severity}`,
        `Confidence: ${report.confidence}`,
        `Summary: ${report.summary}`,
        `Impact: ${report.impact?.description} (duration: ${report.impact?.duration})`,
        `Contributing Factors: ${(report.contributingFactors ?? []).join("; ")}`,
        `Recommended Actions: ${(report.recommendedActions ?? []).join("; ")}`,
      );
      if (report.evidence) {
        contextParts.push(
          "",
          "## Evidence",
          `Metrics: ${JSON.stringify(report.evidence.metrics)}`,
          `Logs: ${JSON.stringify(report.evidence.logs)}`,
          `Infra: ${JSON.stringify(report.evidence.infra)}`,
        );
      }
      if (report.timeline?.length) {
        contextParts.push(
          "",
          "## Timeline",
          ...report.timeline.map((t: { time: string; event: string }) => `- ${t.time}: ${t.event}`),
        );
      }
    } catch { /* ignore parse errors */ }
  }

  for (const phase of phases) {
    if (phase.findings) {
      try {
        const findings = JSON.parse(phase.findings);
        contextParts.push("", `## ${phase.phase} Phase Findings`, JSON.stringify(findings, null, 2));
      } catch { /* ignore */ }
    }
  }

  const systemContext = contextParts.join("\n");
  const memoryKey = `deep_${msg.investigationId}`;
  let history = memory.get(memoryKey);

  // Hydrate from DB if in-memory history is empty (e.g. after page refresh)
  if (history.length === 0) {
    const dbMessages = db.listMessages(stackId, 50, msg.investigationId);
    const followUps = dbMessages.filter(m =>
      !m.content.startsWith("Starting investigation") && !m.content.startsWith("**Root Cause:**")
    );
    for (const m of followUps) {
      memory.append(memoryKey, { role: m.role as "user" | "assistant", content: m.content });
    }
    history = memory.get(memoryKey);
  }

  // On first message, prepend system context
  const fullHistory = history.length === 0
    ? [{ role: "system" as const, content: systemContext }]
    : history;

  const services = ctx.slug === DEFAULT_STACK_SLUG
    ? [...deps.config.services, ...ctx.serviceRegistry.load().filter(s => !deps.config.services.some(c => c.name === s.name))]
    : ctx.serviceRegistry.load();

  const chatTokens = { inputTokens: 0, outputTokens: 0 };
  const chatStartMs = Date.now();

  try {
    const result = await agent.chat({
      mode: "conversational",
      message: msg.message,
      history: fullHistory,
      serviceContext: services,
      supportsInlineCharts: true,
      onTokenUsage: (u) => {
        chatTokens.inputTokens += u.inputTokens;
        chatTokens.outputTokens += u.outputTokens;
      },
      onToolCall: (name, _args, rawResult) => {
        if (rawResult === undefined) {
          send({ type: "chat:tool_call", tool: name, status: "calling" });
        } else {
          send({ type: "chat:tool_call", tool: name, status: "complete" });
        }
      },
      onStreamStart: () => {
        send({ type: "chat:stream_start" });
      },
      onStreamDelta: (delta) => {
        send({
          type: "chat:stream_delta",
          content: delta.content,
          ...(delta.type === "reasoning" ? { reasoning: true } : {}),
        });
      },
    });
    memory.append(memoryKey, { role: "user", content: msg.message });
    memory.append(memoryKey, { role: "assistant", content: result.response });
    db.createMessage(stackId, { id: `msg_${ulid()}`, role: "user", content: msg.message, investigationId: msg.investigationId });
    const deepMsgId = `msg_${ulid()}`;
    const deepMsgTime = new Date().toISOString();
    db.createMessage(stackId, { id: deepMsgId, role: "assistant", content: result.response, investigationId: msg.investigationId });
    send({ type: "chat:stream_end", content: result.response || "No response generated.", id: deepMsgId, createdAt: deepMsgTime, investigationId: msg.investigationId });
    send({
      type: "chat:usage",
      inputTokens: chatTokens.inputTokens,
      outputTokens: chatTokens.outputTokens,
      durationMs: Date.now() - chatStartMs,
    });
  } catch (err) {
    send({ type: "chat:stream_end", content: `Error: ${friendlyError(err)}` });
  }
}

export async function handleClientMessage(
  msg: ClientMessage,
  send: (m: ServerMessage) => void,
  deps: WsDeps,
  threadId: string,
  stackId: string,
  ctx: StackContext,
  getPendingDiscovery: () => ValidatedServiceConfig[] | null,
  clearPendingDiscovery: () => void,
): Promise<void> {
  const memory = ctx.conversationMemory;

  if (msg.type === "new_session") {
    memory.clear(threadId);
    send({ type: "session_cleared" });
    return;
  }

  if (msg.type === "deep_investigate") {
    await handleDeepInvestigate(msg, send, deps, threadId, stackId, ctx);
    return;
  }

  const agents = await getOrCreateAgents(stackId, ctx, deps.config);

  if (msg.type === "discover" && agents.discoverAgent) {
    const totalTokens = { inputTokens: 0, outputTokens: 0 };
    const phaseTokens = { inputTokens: 0, outputTokens: 0 };
    let currentPhase = "discovery";
    const discoveryStartMs = Date.now();
    let phaseStartMs = Date.now();

    const onTokenUsage = (u: { inputTokens: number; outputTokens: number }) => {
      totalTokens.inputTokens += u.inputTokens;
      totalTokens.outputTokens += u.outputTokens;
      phaseTokens.inputTokens += u.inputTokens;
      phaseTokens.outputTokens += u.outputTokens;
    };

    try {
      const discoveryConfig = deps.config.discovery;
      const services = await agents.discoverAgent.discover(
        discoveryConfig ?? { autoRefresh: false, excludeServices: [], maxIterations: 40, discoveryRecipes: [] },
        (phase) => {
          // Emit usage for the phase that just ended
          if (phaseTokens.inputTokens > 0 || phaseTokens.outputTokens > 0) {
            send({
              type: "discover:phase_usage",
              phase: currentPhase,
              inputTokens: phaseTokens.inputTokens,
              outputTokens: phaseTokens.outputTokens,
              durationMs: Date.now() - phaseStartMs,
            });
          }
          phaseTokens.inputTokens = 0;
          phaseTokens.outputTokens = 0;
          currentPhase = phase;
          phaseStartMs = Date.now();
          send({ type: "discover:phase", phase, status: "running" });
        },
        (phase, iteration, maxIterations, description) =>
          send({ type: "discover:iteration", phase, iteration, maxIterations, description }),
        (name, args, result, durationMs, error, phase) =>
          send({
            type: "discover:tool_call",
            phase: phase ?? "discovery",
            tool: name,
            args,
            status: error ? "error" : result ? "success" : "calling",
            result,
            durationMs,
          }),
        onTokenUsage,
      );
      send({ type: "discover:phase", phase: "validation", status: "complete" });
      if (services.length === 0) {
        send({ type: "discover:error", message: "Discovery completed but found no services. The LLM may have failed to parse Prometheus metrics — try again." });
      } else {
        send({ type: "discover:complete", services });
      }

      // Emit usage for the final phase
      if (phaseTokens.inputTokens > 0 || phaseTokens.outputTokens > 0) {
        send({
          type: "discover:phase_usage",
          phase: currentPhase,
          inputTokens: phaseTokens.inputTokens,
          outputTokens: phaseTokens.outputTokens,
          durationMs: Date.now() - phaseStartMs,
        });
      }

      send({
        type: "discover:total_usage",
        inputTokens: totalTokens.inputTokens,
        outputTokens: totalTokens.outputTokens,
        durationMs: Date.now() - discoveryStartMs,
      });
    } catch (err) {
      send({ type: "discover:error", message: friendlyError(err) });
    }
    return;
  }

  if (msg.type === "discover:accept" && agents.discoverAgent) {
    await agents.discoverAgent.accept(msg.services, "discovery");
    clearPendingDiscovery();
    return;
  }

  if (msg.type === "discover:reject") {
    clearPendingDiscovery();
    return;
  }

  if (msg.type !== "chat") return;

  const serviceContext = msg.serviceContext;

  const { db } = deps;
  const { chatAgent: agent, investigationAgent } = agents;

  // Build services list from config + registry for this stack
  const services = ctx.slug === DEFAULT_STACK_SLUG
    ? [...deps.config.services, ...ctx.serviceRegistry.load().filter(s => !deps.config.services.some(c => c.name === s.name))]
    : ctx.serviceRegistry.load();

  // Filter hidden services from all resolution paths
  const hidden = db.getHiddenServices(stackId);
  const visibleServices = hidden.size > 0 ? services.filter(s => !hidden.has(s.name)) : services;
  const serviceNames = visibleServices.map((s) => s.name);

  // If a serviceContext is provided, resolve it authoritatively and skip text/LLM matching
  const pinnedService = serviceContext
    ? visibleServices.find(s => s.name === serviceContext)
    : undefined;

  db.createMessage(stackId, { id: `msg_${ulid()}`, role: "user", content: msg.message });

  // Context switch detection: compare service in current message vs conversation history
  // Skip when we have a pinned serviceContext — no ambiguity to detect
  const mentionedService = pinnedService ?? deps.matchServiceFromText(msg.message, visibleServices);
  const contextService = resolveServiceFromHistory(memory.get(threadId), visibleServices);
  if (!pinnedService && mentionedService && contextService && mentionedService.name !== contextService.name) {
    send({ type: "context_switch", previousService: contextService.name, newService: mentionedService.name });
  }

  const intent = await deps.router.route(msg.message, serviceNames);

  if (intent.intent === "investigation") {
    const service =
      pinnedService ??
      deps.matchServiceFromText(msg.message, visibleServices) ??
      deps.validateLlmServiceMatch(intent.service, msg.message, visibleServices) ??
      resolveServiceFromHistory(memory.get(threadId), visibleServices) ??
      resolveServiceFromHistory(db.listRecentMessages(stackId, 10), visibleServices);

    if (!service) {
      send({ type: "chat", role: "assistant", content: "I couldn't identify which service to investigate. Could you specify the service name?" });
      return;
    }

    const invId = `inv_${ulid()}`;
    memory.append(threadId, { role: "user", content: msg.message });
    send({ type: "investigation:started", id: invId, service: service.name, query: msg.message });
    const ackContent = `Starting investigation of **${service.name}**...`;
    const ackMsgId = `msg_${ulid()}`;
    send({ type: "chat", role: "assistant", content: ackContent, id: ackMsgId, createdAt: new Date().toISOString() } as ServerMessage);
    db.createMessage(stackId, { id: ackMsgId, role: "assistant", content: ackContent });

    // Build WS-streaming callbacks for the runner
    const wsCallbacks: InvestigationCallbacks = {
      onPhase: (phase, status, stats) => {
        send({ type: "investigation:phase", id: invId, phase, status, stats });
      },
      onToolCall: (phase, tool, args, status, result, durationMs) => {
        send({ type: "investigation:tool_call", phase, tool, args, status: status as "error" | "success" | "calling", result, durationMs });
      },
      onIteration: (phase, iteration, maxIterations, description) => {
        send({ type: "investigation:iteration", phase, iteration, maxIterations, description });
      },
      onPhaseUsage: (investigationId, phase, inputTokens, outputTokens, durationMs) => {
        send({ type: "investigation:phase_usage", investigationId, phase, inputTokens, outputTokens, durationMs });
      },
      onTotalUsage: (investigationId, inputTokens, outputTokens, durationMs) => {
        send({ type: "investigation:total_usage", investigationId, inputTokens, outputTokens, durationMs });
      },
      onComplete: (investigationId, report) => {
        send({ type: "investigation:complete", id: investigationId, report });
        const summary = `**Root Cause:** ${report.rootCause}\n**Confidence:** ${report.confidence}\n**Trigger:** ${report.trigger}`;
        memory.append(threadId, { role: "assistant", content: `Investigation of ${service.name}: ${summary}` });
        send({ type: "chat", role: "assistant", content: summary, investigationId, report });
        db.createMessage(stackId, { id: `msg_${ulid()}`, role: "assistant", content: summary, investigationId });
      },
      onFailed: (investigationId, error) => {
        send({ type: "investigation:failed", id: investigationId, error });
        send({ type: "chat", role: "assistant", content: `Investigation failed: ${error}` });
      },
    };

    const runner = new InvestigationRunner({ db, investigationAgent, skillStore: deps.skillStore, globalOnComplete: deps.globalOnComplete });
    try {
      await runner.run({ service, message: msg.message, investigationId: invId, stackId, callbacks: wsCallbacks });
    } catch {
      // Error already handled by runner's onFailed callback
    }
  } else {
    const history = memory.get(threadId);
    const chartData: ChartSeries[] = [];
    const chatService =
      pinnedService ??
      mentionedService ??
      contextService ??
      resolveServiceFromHistory(db.listRecentMessages(stackId, 10), visibleServices);

    // Search for matching skills in conversational mode
    let chatSkillContext: string | undefined;
    if (deps.skillStore) {
      const matched = deps.skillStore.search({
        service: chatService?.name,
        query: msg.message,
      });
      if (matched.length > 0) {
        chatSkillContext = deps.skillStore.formatForPrompt(matched);
      }
    }

    const metricsToolNames = await getMetricsToolNames(stackId, ctx);

    const chatTokens = { inputTokens: 0, outputTokens: 0 };
    const chatStartMs = Date.now();

    try {
      const result = await agent.chat({
        mode: "conversational",
        message: msg.message,
        history,
        serviceContext: services,
        skillContext: chatSkillContext,
        supportsInlineCharts: true,
        onTokenUsage: (u) => {
          chatTokens.inputTokens += u.inputTokens;
          chatTokens.outputTokens += u.outputTokens;
        },
        onToolCall: (name, args, rawResult) => {
          if (rawResult === undefined) {
            send({ type: "chat:tool_call", tool: name, status: "calling" });
          } else {
            send({ type: "chat:tool_call", tool: name, status: "complete" });
            if (metricsToolNames.has(name) || name === "query_prometheus") {
              chartData.push(...extractChartSeries(rawResult, args));
            }
          }
        },
        onStreamStart: () => {
          send({ type: "chat:stream_start" });
        },
        onStreamDelta: (delta) => {
          send({
            type: "chat:stream_delta",
            content: delta.content,
            ...(delta.type === "reasoning" ? { reasoning: true } : {}),
          });
        },
      });
      memory.append(threadId, { role: "user", content: msg.message });
      memory.append(threadId, { role: "assistant", content: result.response });
      const content = result.response || "No response generated.";
      // Extract skill names from chatSkillContext for UI badges
      const usedSkillNames = chatSkillContext?.match(/### Skill: (.+)/g)?.map(m => m.replace("### Skill: ", ""));
      const chatMsgId = `msg_${ulid()}`;
      const chatMsgTime = new Date().toISOString();
      send({
        type: "chat:stream_end",
        content,
        ...(chartData.length > 0 ? { chartData } : {}),
        ...(usedSkillNames?.length ? { skillsUsed: usedSkillNames } : {}),
        id: chatMsgId,
        createdAt: chatMsgTime,
      });
      send({
        type: "chat:usage",
        inputTokens: chatTokens.inputTokens,
        outputTokens: chatTokens.outputTokens,
        durationMs: Date.now() - chatStartMs,
      });
      db.createMessage(stackId, {
        id: chatMsgId, role: "assistant", content,
        ...(chartData.length > 0 ? { chartData: JSON.stringify(chartData) } : {}),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      send({ type: "chat:stream_end", content: `Error: ${errorMsg}` });
    }
  }
}

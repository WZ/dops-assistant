import { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { ulid } from "ulid";
import pino from "pino";
import type { Database } from "./db.js";
import type { ChatAgent } from "../agent/core.js";
import type { InvestigationAgent } from "../agent/investigation.js";
import type { IntentRouter } from "../agent/intent.js";
import { resolveServiceFromHistory } from "../agent/intent.js";
import type { ConversationMemory } from "../memory/conversation.js";
import type { ServiceConfig } from "../config/schema.js";
import type { ClientMessage, ServerMessage, PhaseStats, ChartSeries } from "../shared/ws-types.js";
import type { SkillStore } from "../skills/store.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

/**
 * Map backend investigation phase names (from investigation.ts onPhase callback)
 * to the short phase names the frontend expects ("planning", "metrics", "logs", "infra", "synthesis").
 *
 * Some backend phases map to multiple frontend phases (e.g. the parallel evidence
 * phase covers metrics, logs, and infra simultaneously).
 */
function mapBackendPhase(backendPhase: string): string[] {
  switch (backendPhase) {
    case "Detecting anomalies":
      return ["planning"];
    case "Planning investigation":
      return ["planning"];
    case "Analyzing metrics, logs & infrastructure":
      return ["metrics", "logs", "infra"];
    case "Analyzing metrics":
      return ["metrics"];
    case "Analyzing logs":
      return ["logs"];
    case "Checking infrastructure":
      return ["infra"];
    case "Building event timeline":
      return ["synthesis"];
    case "Synthesizing root cause":
      return ["synthesis"];
    case "Validating report":
      return ["synthesis"];
    default:
      return [];
  }
}

const MAX_CHART_SERIES = 4;

/** Return true when a series is a flat constant (no variation worth charting) */
function isFlatSeries(values: [string, number][]): boolean {
  if (values.length < 2) return true;
  const first = values[0][1];
  return values.every(([, v]) => v === first);
}

/** Extract chart-renderable time-series from a raw query_prometheus tool result */
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
  agent: ChatAgent;
  investigationAgent: InvestigationAgent;
  router: IntentRouter;
  memory: ConversationMemory;
  services: ServiceConfig[];
  skillStore?: SkillStore;
  validateLlmServiceMatch: (llmService: string | undefined, userMessage: string, services: ServiceConfig[]) => ServiceConfig | undefined;
  matchServiceFromText: (text: string, services: ServiceConfig[]) => ServiceConfig | undefined;
}

export function setupWebSocket(server: Server, deps: WsDeps): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    const threadId = `web_${ulid()}`;
    logger.info({ threadId }, "WebSocket client connected");

    ws.on("message", async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        const send = (m: ServerMessage) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(m));
          }
        };
        await handleClientMessage(msg, send, deps, threadId);
      } catch (err) {
        logger.error({ err }, "WebSocket message handling error");
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: "Internal error" }));
        }
      }
    });

    ws.on("close", () => {
      logger.info({ threadId }, "WebSocket client disconnected");
    });
  });
}

async function handleDeepInvestigate(
  msg: { type: "deep_investigate"; investigationId: string; message: string },
  send: (m: ServerMessage) => void,
  deps: WsDeps,
  threadId: string,
): Promise<void> {
  const { db, agent, memory } = deps;

  const investigation = db.getInvestigation(msg.investigationId);
  if (!investigation) {
    send({ type: "chat:stream_end", content: "Investigation not found." });
    return;
  }

  const phases = db.getPhases(msg.investigationId);

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
    const dbMessages = db.listMessages(50, msg.investigationId);
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

  try {
    const result = await agent.chat({
      mode: "conversational",
      message: msg.message,
      history: fullHistory,
      serviceContext: deps.services,
      supportsInlineCharts: true,
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
    db.createMessage({ id: `msg_${ulid()}`, role: "user", content: msg.message, investigationId: msg.investigationId });
    db.createMessage({ id: `msg_${ulid()}`, role: "assistant", content: result.response, investigationId: msg.investigationId });
    send({ type: "chat:stream_end", content: result.response || "No response generated." });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    send({ type: "chat:stream_end", content: `Error: ${errorMsg}` });
  }
}

export async function handleClientMessage(
  msg: ClientMessage,
  send: (m: ServerMessage) => void,
  deps: WsDeps,
  threadId: string,
): Promise<void> {
  if (msg.type === "new_session") {
    deps.memory.clear(threadId);
    send({ type: "session_cleared" });
    return;
  }

  if (msg.type === "deep_investigate") {
    await handleDeepInvestigate(msg, send, deps, threadId);
    return;
  }

  if (msg.type !== "chat") return;

  const { db, agent, investigationAgent, router, memory, services } = deps;
  const serviceNames = services.map((s) => s.name);

  db.createMessage({ id: `msg_${ulid()}`, role: "user", content: msg.message });

  // Context switch detection: compare service in current message vs conversation history
  const mentionedService = deps.matchServiceFromText(msg.message, services);
  const contextService = resolveServiceFromHistory(memory.get(threadId), services);
  if (mentionedService && contextService && mentionedService.name !== contextService.name) {
    send({ type: "context_switch", previousService: contextService.name, newService: mentionedService.name });
  }

  const intent = await router.route(msg.message, serviceNames);

  if (intent.intent === "investigation") {
    const service =
      deps.matchServiceFromText(msg.message, services) ??
      deps.validateLlmServiceMatch(intent.service, msg.message, services) ??
      resolveServiceFromHistory(memory.get(threadId), services) ??
      resolveServiceFromHistory(db.listRecentMessages(10), services);

    if (!service) {
      send({ type: "chat", role: "assistant", content: "I couldn't identify which service to investigate. Could you specify the service name?" });
      return;
    }

    const invId = `inv_${ulid()}`;
    db.createInvestigation({ id: invId, service: service.name, query: msg.message, status: "running" });
    memory.append(threadId, { role: "user", content: msg.message });
    send({ type: "investigation:started", id: invId, service: service.name, query: msg.message });
    send({ type: "chat", role: "assistant", content: `Starting investigation of **${service.name}**...` });

    // Search for matching skills
    let skillContext: string | undefined;
    if (deps.skillStore) {
      const matchedSkills = deps.skillStore.search({ service: service.name, query: msg.message });
      if (matchedSkills.length > 0) {
        skillContext = deps.skillStore.formatForPrompt(matchedSkills);
        logger.debug({ skillCount: matchedSkills.length, skills: matchedSkills.map(s => s.id) }, "Injecting skills into investigation");
      }
    }

    try {
      const runningPhases = new Set<string>();
      const phaseStats = new Map<string, { toolCalls: number; iterations: number; startMs: number }>();

      // Helper: send event to client AND persist to DB
      const emit = (event: ServerMessage) => {
        send(event);
        if (event.type === "investigation:tool_call" || event.type === "investigation:iteration" || event.type === "investigation:phase") {
          db.createEvent({ id: `evt_${ulid()}`, investigationId: invId, eventType: event.type, payload: JSON.stringify(event) });
        }
      };

      const report = await investigationAgent.investigate(
        service, undefined, invId, undefined, msg.message,
        // onToolCall — enriched (phase passed from workflow for parallel steps)
        (name, args, result, durationMs, error, phase) => {
          const activePhase = phase ?? (runningPhases.size > 0 ? [...runningPhases][0]! : "planning");
          const stats = phaseStats.get(activePhase);
          if (stats && (result !== undefined || error !== undefined)) stats.toolCalls++;

          if (error) {
            emit({ type: "investigation:tool_call", phase: activePhase, tool: name, args, status: "error", result: error, durationMs });
          } else if (result !== undefined) {
            emit({ type: "investigation:tool_call", phase: activePhase, tool: name, args, status: "success", result, durationMs });
          } else {
            emit({ type: "investigation:tool_call", phase: activePhase, tool: name, args, status: "calling" });
          }
        },
        // onPhase
        (backendPhase) => {
          const frontendPhases = mapBackendPhase(backendPhase);

          for (const prev of runningPhases) {
            if (!frontendPhases.includes(prev)) {
              const stats = phaseStats.get(prev);
              const durationMs = stats ? Date.now() - stats.startMs : 0;
              emit({
                type: "investigation:phase", phase: prev, status: "complete",
                stats: stats ? { observationCount: 0, criticalCount: 0, toolCalls: stats.toolCalls, iterations: stats.iterations, durationMs } : undefined,
              });
              runningPhases.delete(prev);
            }
          }

          for (const fp of frontendPhases) {
            if (!runningPhases.has(fp)) {
              emit({ type: "investigation:phase", phase: fp, status: "running" });
              runningPhases.add(fp);
              phaseStats.set(fp, { toolCalls: 0, iterations: 0, startMs: Date.now() });
            }
          }
        },
        // onIteration
        (phase, iteration, maxIterations, description) => {
          const frontendPhase = runningPhases.has(phase) ? phase : (runningPhases.size > 0 ? [...runningPhases][0]! : phase);
          const stats = phaseStats.get(frontendPhase);
          if (stats) stats.iterations = Math.max(stats.iterations, iteration + 1);
          emit({ type: "investigation:iteration", phase: frontendPhase, iteration, maxIterations, description });
        },
        skillContext,
      );

      // Complete remaining phases with stats
      for (const fp of runningPhases) {
        const stats = phaseStats.get(fp);
        const durationMs = stats ? Date.now() - stats.startMs : 0;
        emit({
          type: "investigation:phase", phase: fp, status: "complete",
          stats: stats ? { observationCount: 0, criticalCount: 0, toolCalls: stats.toolCalls, iterations: stats.iterations, durationMs } : undefined,
        });
      }
      runningPhases.clear();

      db.updateInvestigation(invId, { status: "complete", report: JSON.stringify(report) });
      send({ type: "investigation:complete", id: invId, report });

      const summary = `**Root Cause:** ${report.rootCause}\n**Confidence:** ${report.confidence}\n**Trigger:** ${report.trigger}`;
      memory.append(threadId, { role: "assistant", content: `Investigation of ${service.name}: ${summary}` });
      send({ type: "chat", role: "assistant", content: summary, investigationId: invId, report });
      db.createMessage({ id: `msg_${ulid()}`, role: "assistant", content: summary, investigationId: invId });
    } catch (err) {
      logger.error({ err, invId, service: service.name }, "Investigation failed");
      db.updateInvestigation(invId, { status: "failed" });
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      send({ type: "investigation:failed", id: invId, error: errorMsg });
      send({ type: "chat", role: "assistant", content: `Investigation failed: ${errorMsg}` });
    }
  } else {
    const history = memory.get(threadId);
    const chartData: ChartSeries[] = [];
    const chatService =
      mentionedService ??
      contextService ??
      resolveServiceFromHistory(db.listRecentMessages(10), services);

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

    try {
      const result = await agent.chat({
        mode: "conversational",
        message: msg.message,
        history,
        serviceContext: services,
        skillContext: chatSkillContext,
        supportsInlineCharts: true,
        onToolCall: (name, args, rawResult) => {
          if (rawResult === undefined) {
            send({ type: "chat:tool_call", tool: name, status: "calling" });
          } else {
            send({ type: "chat:tool_call", tool: name, status: "complete" });
            if (name === "query_prometheus") {
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
      send({
        type: "chat:stream_end",
        content,
        ...(chartData.length > 0 ? { chartData } : {}),
        ...(usedSkillNames?.length ? { skillsUsed: usedSkillNames } : {}),
      });
      db.createMessage({
        id: `msg_${ulid()}`, role: "assistant", content,
        ...(chartData.length > 0 ? { chartData: JSON.stringify(chartData) } : {}),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      send({ type: "chat:stream_end", content: `Error: ${errorMsg}` });
    }
  }
}

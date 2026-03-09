import { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { ulid } from "ulid";
import pino from "pino";
import type { Database } from "./db.js";
import type { ChatAgent } from "../agent/core.js";
import type { InvestigationAgent } from "../agent/investigation.js";
import type { IntentRouter } from "../agent/intent.js";
import type { ConversationMemory } from "../memory/conversation.js";
import type { ServiceConfig } from "../config/schema.js";
import type { ClientMessage, ServerMessage, PhaseStats } from "../shared/ws-types.js";

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

export interface WsDeps {
  db: Database;
  agent: ChatAgent;
  investigationAgent: InvestigationAgent;
  router: IntentRouter;
  memory: ConversationMemory;
  services: ServiceConfig[];
  matchService: (query: string | undefined, services: ServiceConfig[]) => ServiceConfig | undefined;
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
    send({ type: "deep_investigate:response", investigationId: msg.investigationId, content: "Investigation not found." });
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
  const history = memory.get(memoryKey);

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
    });
    memory.append(memoryKey, { role: "user", content: msg.message });
    memory.append(memoryKey, { role: "assistant", content: result.response });
    send({ type: "deep_investigate:response", investigationId: msg.investigationId, content: result.response });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    send({ type: "deep_investigate:response", investigationId: msg.investigationId, content: `Error: ${errorMsg}` });
  }
}

export async function handleClientMessage(
  msg: ClientMessage,
  send: (m: ServerMessage) => void,
  deps: WsDeps,
  threadId: string,
): Promise<void> {
  if (msg.type === "deep_investigate") {
    await handleDeepInvestigate(msg, send, deps, threadId);
    return;
  }

  if (msg.type !== "chat") return;

  const { db, agent, investigationAgent, router, memory, services } = deps;
  const serviceNames = services.map((s) => s.name);

  db.createMessage({ id: `msg_${ulid()}`, role: "user", content: msg.message });

  const intent = await router.route(msg.message, serviceNames);

  if (intent.intent === "investigation") {
    const service =
      (intent.service ? deps.matchService(intent.service, services) : undefined) ??
      deps.matchServiceFromText(msg.message, services);

    if (!service) {
      send({ type: "chat", role: "assistant", content: "I couldn't identify which service to investigate. Could you specify the service name?" });
      return;
    }

    const invId = `inv_${ulid()}`;
    db.createInvestigation({ id: invId, service: service.name, query: msg.message, status: "running" });
    send({ type: "investigation:started", id: invId, service: service.name });
    send({ type: "chat", role: "assistant", content: `Starting investigation of **${service.name}**...` });

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
        // onToolCall — enriched
        (name, args, result, durationMs, error) => {
          const activePhase = runningPhases.size > 0 ? [...runningPhases][0]! : "planning";
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
      send({ type: "chat", role: "assistant", content: summary });
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
    try {
      const result = await agent.chat({ mode: "conversational", message: msg.message, history, serviceContext: services });
      memory.append(threadId, { role: "user", content: msg.message });
      memory.append(threadId, { role: "assistant", content: result.response });
      send({ type: "chat", role: "assistant", content: result.response });
      db.createMessage({ id: `msg_${ulid()}`, role: "assistant", content: result.response });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      send({ type: "chat", role: "assistant", content: `Error: ${errorMsg}` });
    }
  }
}

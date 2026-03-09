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
import type { ClientMessage, ServerMessage } from "../shared/ws-types.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

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

export async function handleClientMessage(
  msg: ClientMessage,
  send: (m: ServerMessage) => void,
  deps: WsDeps,
  threadId: string,
): Promise<void> {
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
      const report = await investigationAgent.investigate(
        service, undefined, invId, undefined, msg.message,
        (name, _args) => { send({ type: "investigation:progress", phase: "evidence", step: `Calling ${name}...` }); },
        (phase) => { send({ type: "investigation:phase", phase, status: "running" }); },
      );

      db.updateInvestigation(invId, { status: "complete", report: JSON.stringify(report) });
      send({ type: "investigation:complete", id: invId, report });

      const summary = `**Root Cause:** ${report.rootCause}\n**Confidence:** ${report.confidence}\n**Trigger:** ${report.trigger}`;
      send({ type: "chat", role: "assistant", content: summary });
      db.createMessage({ id: `msg_${ulid()}`, role: "assistant", content: summary, investigationId: invId });
    } catch (err) {
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

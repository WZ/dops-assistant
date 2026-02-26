import pkg from "@slack/bolt";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const { App } = pkg;
type App = InstanceType<typeof pkg.App>;
import { randomUUID } from "node:crypto";
import type { AgentCore } from "../agent/core.js";
import type { IntentClassifier } from "../agent/intent.js";
import type { InvestigationAgent } from "../agent/investigation.js";
import type { ServiceConfig } from "../config/schema.js";
import type { ConversationMemory } from "../memory/conversation.js";
import { formatRcaBlocks } from "../notifications/rca-blocks.js";
import { slackMessagesTotal } from "../observability/metrics.js";

export type SlackConfig = {
  botToken: string;
  appToken: string;
};

type MessageContext = {
  text: string;
  threadTs: string;
  userId: string;
  channelId: string;
};

export class SlackBot {
  private app: App;
  private agent: AgentCore;
  private memory: ConversationMemory;
  private services: ServiceConfig[];
  private classifier?: IntentClassifier;
  private investigationAgent?: InvestigationAgent;

  constructor(
    config: SlackConfig,
    agent: AgentCore,
    memory: ConversationMemory,
    services: ServiceConfig[] = [],
    classifier?: IntentClassifier,
    investigationAgent?: InvestigationAgent,
  ) {
    this.agent = agent;
    this.memory = memory;
    this.services = services;
    this.classifier = classifier;
    this.investigationAgent = investigationAgent;
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  // Public for testing
  async handleMessage(
    ctx: MessageContext,
    say: (msg: object) => Promise<void>,
  ): Promise<void> {
    const correlationId = randomUUID().slice(0, 8);
    const threadId = ctx.threadTs;

    try {
      // Route via intent classifier if available
      if (this.classifier && this.investigationAgent) {
        const intent = await this.classifier.classify(ctx.text);
        if (intent.intent === "investigation") {
          const service = this.services.find((s) => s.name === intent.service)
            ?? this.services[0];

          if (!service) {
            await say({ text: "No services configured to investigate.", thread_ts: threadId });
            slackMessagesTotal.inc({ status: "success" });
            return;
          }

          const report = await this.investigationAgent.investigate(service, undefined, correlationId);
          await say({ blocks: formatRcaBlocks(report), thread_ts: threadId });
          slackMessagesTotal.inc({ status: "success" });
          return;
        }
      }

      // Existing conversational path
      const history = this.memory.get(threadId);
      this.memory.append(threadId, { role: "user", content: ctx.text });

      const result = await this.agent.run({
        mode: "conversational",
        message: ctx.text,
        history,
        correlationId,
      });
      this.memory.append(threadId, { role: "assistant", content: result.response });
      await say({ text: result.response, thread_ts: threadId });

      // Upload images to thread (failures logged, not thrown)
      for (const img of result.images) {
        await this.app.client.filesUploadV2({
          channel_id: ctx.channelId,
          thread_ts: threadId,
          file: img.data,
          filename: img.filename,
        }).catch((err: unknown) => {
          logger.warn({ err, filename: img.filename }, "Failed to upload image to Slack");
        });
      }

      slackMessagesTotal.inc({ status: "success" });
    } catch (err) {
      slackMessagesTotal.inc({ status: "error" });
      await say({ text: "Sorry, something went wrong. Please try again.", thread_ts: threadId }).catch(() => undefined);
      throw err;
    }
  }

  private registerHandlers(): void {
    this.app.message(async ({ message, say }) => {
      const msg = message as { text?: string; ts: string; user?: string; channel?: string };
      if (!msg.text) return;
      await this.handleMessage(
        { text: msg.text, threadTs: msg.ts, userId: msg.user ?? "", channelId: msg.channel ?? "" },
        say as unknown as (msg: object) => Promise<void>,
      );
    });

    this.app.event("app_mention", async ({ event, say }) => {
      const threadTs = event.thread_ts ?? event.ts;
      await this.handleMessage(
        { text: event.text, threadTs, userId: event.user ?? "", channelId: event.channel ?? "" },
        say as unknown as (msg: object) => Promise<void>,
      );
    });
  }
}

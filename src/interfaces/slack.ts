import { App } from "@slack/bolt";
import { randomUUID } from "node:crypto";
import type { AgentCore } from "../agent/core.js";
import type { ConversationMemory } from "../memory/conversation.js";
import { slackMessagesTotal } from "../observability/metrics.js";

export type SlackConfig = {
  botToken: string;
  appToken: string;
};

type MessageContext = {
  text: string;
  threadTs: string;
  userId: string;
};

export class SlackBot {
  private app: App;
  private agent: AgentCore;
  private memory: ConversationMemory;

  constructor(config: SlackConfig, agent: AgentCore, memory: ConversationMemory) {
    this.agent = agent;
    this.memory = memory;
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
    const history = this.memory.get(threadId);

    this.memory.append(threadId, { role: "user", content: ctx.text });

    try {
      const result = await this.agent.run({
        mode: "conversational",
        message: ctx.text,
        history,
        correlationId,
      });
      this.memory.append(threadId, { role: "assistant", content: result.response });
      await say({ text: result.response, thread_ts: threadId });
      slackMessagesTotal.inc({ status: "success" });
    } catch (err) {
      slackMessagesTotal.inc({ status: "error" });
      const errorText = "Sorry, something went wrong. Please try again.";
      await say({ text: errorText, thread_ts: threadId }).catch(() => undefined);
      throw err;
    }
  }

  private registerHandlers(): void {
    this.app.message(async ({ message, say }) => {
      const msg = message as { text?: string; ts: string; user?: string };
      if (!msg.text) return;
      await this.handleMessage(
        { text: msg.text, threadTs: msg.ts, userId: msg.user ?? "" },
        say as unknown as (msg: object) => Promise<void>,
      );
    });

    this.app.event("app_mention", async ({ event, say }) => {
      const threadTs = event.thread_ts ?? event.ts;
      await this.handleMessage(
        { text: event.text, threadTs, userId: event.user ?? "" },
        say as unknown as (msg: object) => Promise<void>,
      );
    });
  }
}

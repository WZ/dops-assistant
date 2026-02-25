import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, TimeoutsConfig } from "../config/schema.js";
import { withTimeout, TimeoutError } from "../utils/timeout.js";
import {
  toolCallsTotal,
  toolDurationSeconds,
} from "../observability/metrics.js";

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export class McpClient {
  private readonly config: McpServerConfig;
  private readonly timeouts: TimeoutsConfig;
  private client: Client | null = null;
  private tools: OpenAITool[] = [];

  constructor(config: McpServerConfig, timeouts: TimeoutsConfig) {
    this.config = config;
    this.timeouts = timeouts;
  }

  async connect(): Promise<void> {
    if (this.client !== null) return;

    let transport: Transport;
    if (this.config.transport === "http") {
      transport = new StreamableHTTPClientTransport(new URL(this.config.url));
    } else {
      transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: { ...process.env, ...this.config.env } as Record<string, string>,
      });
    }

    const client = new Client(
      { name: "dops-assistant", version: "0.1.0" },
      { capabilities: {} },
    );

    let connectSucceeded = false;
    try {
      await withTimeout(client.connect(transport), this.timeouts.mcpConnectMs, "MCP connect");
      connectSucceeded = true;

      const { tools } = await client.listTools();

      const filtered = this.config.enabledTools
        ? tools.filter((t) => this.config.enabledTools!.includes(t.name))
        : tools;

      this.tools = filtered.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.inputSchema as Record<string, unknown>,
        },
      }));

      this.client = client;
    } catch (err) {
      if (connectSucceeded) {
        // Client owns the transport — let it clean up
        await client.close().catch(() => {});
      } else {
        // Client never took ownership — close transport directly
        await transport.close().catch(() => {});
        await client.close().catch(() => {});
      }
      throw err;
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  getTools(): OpenAITool[] {
    if (!this.client) throw new Error("MCP client not connected");
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("MCP client not connected");

    const end = toolDurationSeconds.startTimer({ tool: name });
    try {
      const result = await withTimeout(
        this.client.callTool({ name, arguments: args }),
        this.timeouts.toolExecutionMs,
        `tool:${name}`,
      );
      end();
      const parts = result.content as Array<{ type: string; text?: string }>;
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
      toolCallsTotal.inc({ tool: name, status: "success" });
      return result.isError ? `[Tool Error] ${text}` : text;
    } catch (err) {
      end();
      toolCallsTotal.inc({
        tool: name,
        status: err instanceof TimeoutError ? "timeout" : "error",
      });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.tools = [];
  }
}

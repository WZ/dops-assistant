import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../config/schema.js";

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export class McpClient {
  private config: McpServerConfig;
  private client: Client | null = null;
  private tools: OpenAITool[] = [];

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // TODO: add reconnection logic for future enhancement
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...process.env, ...this.config.env } as Record<string, string>,
    });

    this.client = new Client({ name: "dops-assistant", version: "0.1.0" }, { capabilities: {} });
    await this.client.connect(transport);

    const { tools } = await this.client.listTools();

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
  }

  getTools(): OpenAITool[] {
    if (!this.client) throw new Error("MCP client not connected");
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("MCP client not connected");
    const result = await this.client.callTool({ name, arguments: args });
    const parts = result.content as Array<{ type: string; text?: string }>;
    return parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.tools = [];
  }
}

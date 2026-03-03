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
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type PanelImage = { data: string; mimeType: string };

export type ToolResult = {
  text: string;
  images: PanelImage[];
};

/**
 * Normalise a single from/to value for Grafana's get_panel_image.
 *
 * Grafana render API accepts:
 *   - Relative strings: "now", "now-6h", "now-1d/d"
 *   - Epoch milliseconds as a NUMBER
 *
 * The Grafana MCP server does parseInt() on string values, so ISO dates like
 * "2026-03-02T22:00:00Z" become parseInt("2026") = 2026 ms = 1970-01-01.
 * This function converts ISO dates to epoch ms numbers to prevent that.
 */
export function normalizeGrafanaTime(v: unknown): string | number | null {
  if (typeof v === "string" && v.startsWith("now")) return v;

  if (typeof v === "string" && /^\d{4}-/.test(v)) {
    const ms = new Date(v).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  if (typeof v === "number" && v > 0) {
    return v < 1e11 ? v * 1000 : v; // epoch seconds → ms
  }

  return null;
}

function normalizeImageTimeRange(args: Record<string, unknown>): Record<string, unknown> {
  const raw = args.timeRange;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...args, timeRange: { from: "now-6h", to: "now" } };
  }
  const tr = raw as { from?: unknown; to?: unknown };
  return {
    ...args,
    timeRange: {
      from: normalizeGrafanaTime(tr.from) ?? "now-6h",
      to: normalizeGrafanaTime(tr.to) ?? "now",
    },
  };
}

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

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.client) throw new Error("MCP client not connected");

    const log = logger.child({ tool: name });
    log.debug({ args }, "Calling tool");

    const finalArgs = name === "get_panel_image" ? normalizeImageTimeRange(args) : args;
    const end = toolDurationSeconds.startTimer({ tool: name });
    try {
      const result = await withTimeout(
        this.client.callTool({ name, arguments: finalArgs }),
        this.timeouts.toolExecutionMs,
        `tool:${name}`,
      );
      end();
      const parts = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

      // Count content parts by type for debugging
      const typeCounts: Record<string, number> = {};
      for (const p of parts) {
        typeCounts[p.type] = (typeCounts[p.type] ?? 0) + 1;
      }
      log.debug({ typeCounts, totalParts: parts.length }, "MCP response content parts");

      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");

      const images: PanelImage[] = parts
        .filter((p) => p.type === "image")
        .map((p) => ({ data: p.data ?? "", mimeType: p.mimeType ?? "image/png" }));

      if (images.length > 0) {
        log.debug({ imageCount: images.length }, "Extracted images from response");
      }

      toolCallsTotal.inc({ tool: name, status: "success" });
      return {
        text: result.isError ? `[Tool Error] ${text}` : text,
        images,
      };
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

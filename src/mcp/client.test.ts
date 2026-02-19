import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpClient } from "./client.js";
import type { McpServerConfig } from "../config/schema.js";

// Mock the MCP SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "query_prometheus",
            description: "Query Prometheus metrics",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "PromQL query" },
              },
              required: ["query"],
            },
          },
          {
            name: "query_loki",
            description: "Query Loki logs",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        ],
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "result data" }],
      }),
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

const baseConfig: McpServerConfig = {
  command: "npx",
  args: ["-y", "@grafana/mcp-grafana"],
  env: {},
};

describe("McpClient", () => {
  let client: McpClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects and discovers all tools when no enabledTools filter", async () => {
    client = new McpClient(baseConfig);
    await client.connect();
    const tools = client.getTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].function.name).toBe("query_prometheus");
    expect(tools[1].function.name).toBe("query_loki");
  });

  it("filters tools to only enabledTools when specified", async () => {
    client = new McpClient({ ...baseConfig, enabledTools: ["query_prometheus"] });
    await client.connect();
    const tools = client.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("query_prometheus");
  });

  it("converts tool schema to OpenAI function definition format", async () => {
    client = new McpClient({ ...baseConfig, enabledTools: ["query_prometheus"] });
    await client.connect();
    const tools = client.getTools();
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "query_prometheus",
        description: "Query Prometheus metrics",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "PromQL query" },
          },
          required: ["query"],
        },
      },
    });
  });

  it("executes a tool call and returns text result", async () => {
    client = new McpClient(baseConfig);
    await client.connect();
    const result = await client.callTool("query_prometheus", { query: "up" });
    expect(result).toBe("result data");
  });

  it("throws if getTools called before connect", () => {
    client = new McpClient(baseConfig);
    expect(() => client.getTools()).toThrow("MCP client not connected");
  });

  it("throws if callTool called before connect", async () => {
    client = new McpClient(baseConfig);
    await expect(client.callTool("query_prometheus", {})).rejects.toThrow("MCP client not connected");
  });
});

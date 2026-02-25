import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpClient } from "./client.js";
import type { McpServerConfig } from "../config/schema.js";
import { TimeoutError } from "../utils/timeout.js";

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

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

const baseConfig: McpServerConfig = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@grafana/mcp-grafana"],
  env: {},
};

const baseTimeouts = {
  mcpConnectMs: 30_000,
  llmCallMs: 60_000,
  toolExecutionMs: 30_000,
  agentIterationMs: 90_000,
};

describe("McpClient", () => {
  let client: McpClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects and discovers all tools when no enabledTools filter", async () => {
    client = new McpClient(baseConfig, baseTimeouts);
    await client.connect();
    const tools = client.getTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].function.name).toBe("query_prometheus");
    expect(tools[1].function.name).toBe("query_loki");
  });

  it("filters tools to only enabledTools when specified", async () => {
    client = new McpClient({ ...baseConfig, enabledTools: ["query_prometheus"] }, baseTimeouts);
    await client.connect();
    const tools = client.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("query_prometheus");
  });

  it("converts tool schema to OpenAI function definition format", async () => {
    client = new McpClient({ ...baseConfig, enabledTools: ["query_prometheus"] }, baseTimeouts);
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
    client = new McpClient(baseConfig, baseTimeouts);
    await client.connect();
    const result = await client.callTool("query_prometheus", { query: "up" });
    expect(result).toBe("result data");
  });

  it("throws if getTools called before connect", () => {
    client = new McpClient(baseConfig, baseTimeouts);
    expect(() => client.getTools()).toThrow("MCP client not connected");
  });

  it("throws if callTool called before connect", async () => {
    client = new McpClient(baseConfig, baseTimeouts);
    await expect(client.callTool("query_prometheus", {})).rejects.toThrow("MCP client not connected");
  });

  it("connect() is a no-op when already connected", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    client = new McpClient(baseConfig, baseTimeouts);
    await client.connect();
    await client.connect();
    const instance = (Client as ReturnType<typeof vi.fn>).mock.instances[0];
    expect(instance.connect).toHaveBeenCalledTimes(1);
  });

  it("callTool returns [Tool Error] prefix when isError is true", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    client = new McpClient(baseConfig, baseTimeouts);
    await client.connect();
    const instance = (Client as ReturnType<typeof vi.fn>).mock.instances[0];
    instance.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "metric not found" }],
      isError: true,
    });
    const result = await client.callTool("query_prometheus", { query: "up" });
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toBe("[Tool Error] metric not found");
  });
});

describe("McpClient – timeouts and metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws TimeoutError if connect exceeds mcpConnectMs", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    // Override the mock so the instance's connect hangs forever
    (Client as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return {
        connect: vi.fn().mockImplementation(() => new Promise(() => {})), // hangs forever
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        callTool: vi.fn(),
      };
    });
    const client = new McpClient(
      { transport: "stdio", command: "npx", args: [], env: {}, enabledTools: undefined },
      { mcpConnectMs: 1, llmCallMs: 60_000, toolExecutionMs: 30_000, agentIterationMs: 90_000 },
    );
    await expect(client.connect()).rejects.toBeInstanceOf(TimeoutError);
  });

  it("exposes isConnected()", async () => {
    const client = new McpClient(
      { transport: "stdio", command: "npx", args: [], env: {}, enabledTools: undefined },
      { mcpConnectMs: 30_000, llmCallMs: 60_000, toolExecutionMs: 30_000, agentIterationMs: 90_000 },
    );
    expect(client.isConnected()).toBe(false);
  });
});

describe("McpClient – SSE transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects via SSEClientTransport when transport is 'sse'", async () => {
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const sseConfig: McpServerConfig = {
      transport: "sse",
      url: "http://localhost:8080/sse",
    };
    const client = new McpClient(sseConfig, baseTimeouts);
    await client.connect();
    expect(SSEClientTransport).toHaveBeenCalledTimes(1);
    expect(SSEClientTransport).toHaveBeenCalledWith(new URL("http://localhost:8080/sse"));
  });

  it("discovers and returns tools via SSE connection", async () => {
    const sseConfig: McpServerConfig = {
      transport: "sse",
      url: "http://localhost:8080/sse",
      enabledTools: ["query_prometheus"],
    };
    const client = new McpClient(sseConfig, baseTimeouts);
    await client.connect();
    const tools = client.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("query_prometheus");
  });
});

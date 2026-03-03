import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpClient, normalizeGrafanaTime } from "./client.js";
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
    return { close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
    return { close: vi.fn().mockResolvedValue(undefined) };
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
    expect(result.text).toBe("result data");
    expect(result.images).toEqual([]);
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

  it("callTool returns ToolResult with images when result contains image parts", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    client = new McpClient(baseConfig, baseTimeouts);
    await client.connect();
    const instance = (Client as ReturnType<typeof vi.fn>).mock.instances[0];
    instance.callTool.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Panel rendered" },
        { type: "image", mimeType: "image/png", data: "iVBOR...base64..." },
      ],
    });
    const result = await client.callTool("get_panel_image", { dashboardUid: "abc", panelId: 1 });
    expect(result.text).toBe("Panel rendered");
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.images[0].data).toBe("iVBOR...base64...");
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
    expect(result.text).toMatch(/^\[Tool Error\]/);
    expect(result.text).toBe("[Tool Error] metric not found");
  });
});

describe("McpClient – timeouts and metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws TimeoutError if connect exceeds mcpConnectMs", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    (Client as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return {
        connect: vi.fn().mockImplementation(() => new Promise(() => {})),
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

    const transportInstance = (StdioClientTransport as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(transportInstance.close).toHaveBeenCalled();
  });

  it("exposes isConnected()", async () => {
    const client = new McpClient(
      { transport: "stdio", command: "npx", args: [], env: {}, enabledTools: undefined },
      { mcpConnectMs: 30_000, llmCallMs: 60_000, toolExecutionMs: 30_000, agentIterationMs: 90_000 },
    );
    expect(client.isConnected()).toBe(false);
  });
});

describe("McpClient – HTTP transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects via StreamableHTTPClientTransport when transport is 'http'", async () => {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const httpConfig: McpServerConfig = {
      transport: "http",
      url: "http://localhost:8000/mcp",
    };
    const client = new McpClient(httpConfig, baseTimeouts);
    await client.connect();
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL("http://localhost:8000/mcp"));
  });

  it("discovers and returns tools via HTTP connection", async () => {
    const httpConfig: McpServerConfig = {
      transport: "http",
      url: "http://localhost:8000/mcp",
      enabledTools: ["query_prometheus"],
    };
    const client = new McpClient(httpConfig, baseTimeouts);
    await client.connect();
    const tools = client.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("query_prometheus");
  });

  it("connect() error → transport.close() called", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    (Client as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return {
        connect: vi.fn().mockRejectedValue(new Error("network error")),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        callTool: vi.fn(),
      };
    });

    const httpConfig: McpServerConfig = {
      transport: "http",
      url: "http://localhost:8000/mcp",
    };
    const client = new McpClient(httpConfig, baseTimeouts);
    await expect(client.connect()).rejects.toThrow("network error");

    const transportInstance = (StreamableHTTPClientTransport as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(transportInstance.close).toHaveBeenCalled();
  });

  it("connect() timeout → transport.close() called", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    (Client as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return {
        connect: vi.fn().mockImplementation(() => new Promise(() => {})), // hangs forever
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        callTool: vi.fn(),
      };
    });

    const httpConfig: McpServerConfig = {
      transport: "http",
      url: "http://localhost:8000/mcp",
    };
    const client = new McpClient(httpConfig, { mcpConnectMs: 1, llmCallMs: 60_000, toolExecutionMs: 30_000, agentIterationMs: 90_000 });
    await expect(client.connect()).rejects.toBeInstanceOf(TimeoutError);

    const transportInstance = (StreamableHTTPClientTransport as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(transportInstance.close).toHaveBeenCalled();
  });
});

describe("normalizeGrafanaTime", () => {
  it("passes through relative time strings", () => {
    expect(normalizeGrafanaTime("now")).toBe("now");
    expect(normalizeGrafanaTime("now-1h")).toBe("now-1h");
    expect(normalizeGrafanaTime("now-6h")).toBe("now-6h");
    expect(normalizeGrafanaTime("now-7d/d")).toBe("now-7d/d");
  });

  it("converts ISO 8601 dates to epoch ms", () => {
    const result = normalizeGrafanaTime("2026-03-02T22:00:00Z");
    expect(typeof result).toBe("number");
    expect(result).toBe(new Date("2026-03-02T22:00:00Z").getTime());
    expect(result as number).toBeGreaterThan(1e12);
  });

  it("converts epoch seconds (numbers) to epoch ms", () => {
    expect(normalizeGrafanaTime(1709402400)).toBe(1709402400000);
  });

  it("keeps epoch ms numbers as-is", () => {
    expect(normalizeGrafanaTime(1709402400000)).toBe(1709402400000);
  });

  it("rejects pure numeric strings", () => {
    expect(normalizeGrafanaTime("1709402400")).toBeNull();
    expect(normalizeGrafanaTime("1709402400000")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(normalizeGrafanaTime("hello")).toBeNull();
    expect(normalizeGrafanaTime("")).toBeNull();
    expect(normalizeGrafanaTime(null)).toBeNull();
    expect(normalizeGrafanaTime(undefined)).toBeNull();
    expect(normalizeGrafanaTime(0)).toBeNull();
    expect(normalizeGrafanaTime(-1)).toBeNull();
  });
});

describe("McpClient – get_panel_image timeRange normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts ISO date timeRange to epoch ms before sending to MCP", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new McpClient(baseConfig, baseTimeouts);
    await client.connect();
    const instance = (Client as ReturnType<typeof vi.fn>).mock.instances[0];
    instance.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });

    await client.callTool("get_panel_image", {
      dashboardUid: "abc",
      panelId: 1,
      timeRange: { from: "2026-03-02T22:00:00Z", to: "2026-03-02T23:00:00Z" },
    });

    const sentArgs = instance.callTool.mock.calls[0][0].arguments;
    expect(sentArgs.timeRange.from).toBe(new Date("2026-03-02T22:00:00Z").getTime());
    expect(sentArgs.timeRange.to).toBe(new Date("2026-03-02T23:00:00Z").getTime());
  });

  it("defaults missing timeRange to now-6h/now", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new McpClient(baseConfig, baseTimeouts);
    await client.connect();
    const instance = (Client as ReturnType<typeof vi.fn>).mock.instances[0];
    instance.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });

    await client.callTool("get_panel_image", { dashboardUid: "abc", panelId: 1 });

    const sentArgs = instance.callTool.mock.calls[0][0].arguments;
    expect(sentArgs.timeRange).toEqual({ from: "now-6h", to: "now" });
  });

  it("does NOT normalize args for non-panel-image tools", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new McpClient(baseConfig, baseTimeouts);
    await client.connect();
    const instance = (Client as ReturnType<typeof vi.fn>).mock.instances[0];
    instance.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });

    const args = { query: "up", startTime: "2026-03-02T22:00:00Z" };
    await client.callTool("query_prometheus", args);

    const sentArgs = instance.callTool.mock.calls[0][0].arguments;
    expect(sentArgs).toBe(args); // exact same reference, no transformation
  });
});

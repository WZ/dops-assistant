import { describe, it, expect, vi, beforeEach } from "vitest";
import { GrafanaLokiAdapter } from "./grafana-loki.js";
import type { McpClient, OpenAITool, ToolResult } from "../client.js";

/**
 * Minimal mock of McpClient — only the methods used by GrafanaLokiAdapter.
 */
function createMockMcp(tools: string[], callToolImpl?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>) {
  const openAITools: OpenAITool[] = tools.map((name) => ({
    type: "function" as const,
    function: { name, description: "", parameters: {} },
  }));

  return {
    getTools: vi.fn(() => openAITools),
    callTool: vi.fn(callToolImpl ?? (async () => ({ text: "", images: [] }))),
  } as unknown as McpClient;
}

describe("GrafanaLokiAdapter", () => {
  const lokiUid = "loki-ds-uid";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── getLabelsHint ────────────────────────────────────────────────────────

  describe("getLabelsHint", () => {
    it("returns label names from Loki", async () => {
      const mcp = createMockMcp(
        ["list_loki_label_names", "query_loki_logs"],
        async (name) => {
          if (name === "list_loki_label_names") {
            return { text: JSON.stringify(["app", "namespace", "container_name"]), images: [] };
          }
          return { text: "", images: [] };
        },
      );

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const hint = await adapter.getLabelsHint();

      expect(hint).toContain("Available Loki labels");
      expect(hint).toContain("app");
      expect(hint).toContain("namespace");
      expect(hint).toContain("container_name");

      // Verify it was called with the right datasource UID
      expect(mcp.callTool).toHaveBeenCalledWith("list_loki_label_names", {
        datasourceUid: lokiUid,
      });
    });

    it("handles { labels: [...] } response format", async () => {
      const mcp = createMockMcp(
        ["list_loki_label_names"],
        async () => ({
          text: JSON.stringify({ labels: ["job", "host"] }),
          images: [],
        }),
      );

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const hint = await adapter.getLabelsHint();

      expect(hint).toContain("job");
      expect(hint).toContain("host");
    });

    it("returns empty string when list_loki_label_names tool is missing", async () => {
      const mcp = createMockMcp(["query_loki_logs"]); // no list_loki_label_names

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const hint = await adapter.getLabelsHint();

      expect(hint).toBe("");
      expect(mcp.callTool).not.toHaveBeenCalled();
    });

    it("returns empty string when labels array is empty", async () => {
      const mcp = createMockMcp(
        ["list_loki_label_names"],
        async () => ({ text: JSON.stringify([]), images: [] }),
      );

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const hint = await adapter.getLabelsHint();

      expect(hint).toBe("");
    });

    it("returns empty string on callTool error", async () => {
      const mcp = createMockMcp(
        ["list_loki_label_names"],
        async () => { throw new Error("MCP timeout"); },
      );

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const hint = await adapter.getLabelsHint();

      expect(hint).toBe("");
    });
  });

  // ── getWorkingSelector ───────────────────────────────────────────────────

  describe("getWorkingSelector", () => {
    const service = { name: "ingestion-server", metrics: [], logLabels: {} };

    it("probes candidates and returns first hit", async () => {
      const mcp = createMockMcp(
        ["query_loki_logs"],
        async (_name, args) => {
          const logql = args.logql as string;
          // Only the container_name selector returns data
          if (logql.includes("container_name")) {
            return { text: '{"data":[{"line":"some log output here"}]}', images: [] };
          }
          return { text: '{"data":[]}', images: [] };
        },
      );

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const selector = await adapter.getWorkingSelector(service);

      expect(selector).toBe('{container_name="ingestion-server"}');
    });

    it("uses configured logLabels first when provided", async () => {
      const serviceWithLabels = {
        name: "ingestion-server",
        metrics: [],
        logLabels: { app: "ingestion", namespace: "prod" },
      };

      const callOrder: string[] = [];
      const mcp = createMockMcp(
        ["query_loki_logs"],
        async (_name, args) => {
          const logql = args.logql as string;
          callOrder.push(logql);
          // The configured selector returns data
          if (logql.includes('app="ingestion"')) {
            return { text: '{"data":[{"line":"log line"}]}', images: [] };
          }
          return { text: '{"data":[]}', images: [] };
        },
      );

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const selector = await adapter.getWorkingSelector(serviceWithLabels);

      expect(selector).toContain('app="ingestion"');
      expect(selector).toContain('namespace="prod"');
      // The configured selector should be tried first
      expect(callOrder[0]).toContain('app="ingestion"');
    });

    it("passes probeWindow to Loki queries", async () => {
      const mcp = createMockMcp(
        ["query_loki_logs"],
        async (_name, args) => {
          // Return data for the first candidate so we can check args
          return { text: '{"data":[{"line":"log line here"}]}', images: [] };
        },
      );

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const window = { startRfc3339: "2026-03-07T00:00:00Z", endRfc3339: "2026-03-07T01:00:00Z" };
      await adapter.getWorkingSelector(service, window);

      expect(mcp.callTool).toHaveBeenCalledWith("query_loki_logs", expect.objectContaining({
        datasourceUid: lokiUid,
        startRfc3339: "2026-03-07T00:00:00Z",
        endRfc3339: "2026-03-07T01:00:00Z",
        limit: 1,
      }));
    });

    it("falls back to regex patterns when exact matches fail", async () => {
      const mcp = createMockMcp(
        ["query_loki_logs"],
        async (_name, args) => {
          const logql = args.logql as string;
          // Only regex patterns return data
          if (logql.includes("=~")) {
            return { text: '{"data":[{"line":"found via regex"}]}', images: [] };
          }
          return { text: '{"data":[]}', images: [] };
        },
      );

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const selector = await adapter.getWorkingSelector(service);

      expect(selector).toContain("=~");
      expect(selector).toContain("ingestion-server");
    });

    it("returns empty string when no candidates match", async () => {
      const mcp = createMockMcp(
        ["query_loki_logs"],
        async () => ({ text: '{"data":[]}', images: [] }),
      );

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const selector = await adapter.getWorkingSelector(service);

      expect(selector).toBe("");
    });

    it("returns empty string when query_loki_logs tool is missing", async () => {
      const mcp = createMockMcp(["list_loki_label_names"]); // no query_loki_logs

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const selector = await adapter.getWorkingSelector(service);

      expect(selector).toBe("");
      expect(mcp.callTool).not.toHaveBeenCalled();
    });

    it("skips failed candidates and continues probing", async () => {
      let callCount = 0;
      const mcp = createMockMcp(
        ["query_loki_logs"],
        async (_name, args) => {
          callCount++;
          const logql = args.logql as string;
          // First candidate throws, second returns empty, third returns data
          if (logql.includes("job=")) throw new Error("connection error");
          if (logql.includes("container_name=") && !logql.includes("=~")) {
            return { text: '{"data":[{"line":"found it"}]}', images: [] };
          }
          return { text: '{"data":[]}', images: [] };
        },
      );

      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const selector = await adapter.getWorkingSelector(service);

      expect(selector).toBe('{container_name="ingestion-server"}');
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ── getPromptFragment ────────────────────────────────────────────────────

  describe("getPromptFragment", () => {
    it("returns Loki-specific instructions containing key identifiers", () => {
      const mcp = createMockMcp([]);
      const adapter = new GrafanaLokiAdapter(mcp, lokiUid);
      const fragment = adapter.getPromptFragment();

      expect(fragment).toContain("query_loki_logs");
      expect(fragment).toContain("startRfc3339");
      expect(fragment).toContain("endRfc3339");
      expect(fragment).toContain("VALIDATED LOG SELECTOR");
      expect(fragment).toContain("Grafana Loki");
    });
  });
});

import type { MastraProvider } from "../../mcp/provider.js";
import type { McpCheckOutput, McpCheckProvider } from "../types.js";

export async function runMcpCheck(providers: MastraProvider[]): Promise<McpCheckOutput> {
  const start = performance.now();
  const results: McpCheckProvider[] = [];
  let anyError = false;

  for (const provider of providers) {
    try {
      const tools = await provider.client.listTools();
      const toolNames = Object.keys(tools);
      results.push({
        name: provider.name,
        status: "connected",
        toolsCount: toolNames.length,
        tools: toolNames,
        error: null,
      });
    } catch (err) {
      anyError = true;
      results.push({
        name: provider.name,
        status: "error",
        toolsCount: 0,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    command: "mcp-check",
    status: anyError ? "error" : "success",
    durationMs: Math.round(performance.now() - start),
    providers: results,
  };
}

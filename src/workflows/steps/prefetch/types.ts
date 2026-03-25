import type { Tool } from "@mastra/core/tools";
import type { MastraProvider } from "../../../mcp/provider.js";
import type { ServiceConfig } from "../../../config/schema.js";
import type { PrefetchedContext } from "../../../types/workflow-state.js";

export type ToolMap = { provider: MastraProvider; tools: Record<string, Tool> };

export interface PrefetchStrategy {
  name: string;
  fetchDatasourceHints(toolMaps: ToolMap[], providers: MastraProvider[]): Promise<string>;
  fetchDashboardContext(
    toolMaps: ToolMap[],
    providers: MastraProvider[],
    opts?: { userMessage?: string; anomalySummary?: string; datasourceHints?: string; serviceName?: string },
  ): Promise<{ dashboardContext: string; panelQueryHints: string }>;
  fetchLogContext(
    toolMaps: ToolMap[],
    providers: MastraProvider[],
    services: ServiceConfig[],
    datasourceHints: string,
    targetServiceName?: string,
  ): Promise<{ logLabelHints: string; workingLogSelectors: string[] }>;
}

// Re-export types used by callers
export type { MastraProvider, ServiceConfig, PrefetchedContext };

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Find a tool by unprefixed name. MCP providers prefix tool names
 * (e.g. "grafana_list_datasources" for "list_datasources").
 * Falls back to exact match, then suffix match.
 */
export function findTool(tools: Record<string, Tool>, toolName: string): Tool | undefined {
  if (tools[toolName]) return tools[toolName];
  // Suffix match: "list_datasources" matches "grafana_list_datasources"
  const entry = Object.entries(tools).find(([key]) => key.endsWith(`_${toolName}`) || key.endsWith(toolName));
  return entry?.[1];
}

/**
 * Check if a tool exists by unprefixed name (handles MCP provider prefixing).
 */
export function hasTool(tools: Record<string, Tool>, toolName: string): boolean {
  return findTool(tools, toolName) !== undefined;
}

/**
 * Call a Mastra Tool by name using the provider's MCPClient.
 * Handles MCP provider name prefixing (e.g. "grafana_list_datasources").
 * Returns the raw result as a string, or null on failure.
 */
export async function callProviderTool(
  tools: Record<string, Tool>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const tool = findTool(tools, toolName);
  if (!tool?.execute) return null;

  try {
    const result = await tool.execute(args as any, {} as any);
    if (result === null || result === undefined) return null;
    // Unwrap MCP content structure: {content: [{type: "text", text: "..."}]}
    let unwrapped = result;
    if (typeof result === "object" && !Array.isArray(result)) {
      const content = (result as any).content;
      if (Array.isArray(content) && content.length > 0 && content[0]?.type === "text") {
        unwrapped = content[0].text;
      }
    }
    const str = typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped);
    return str;
  } catch {
    return null;
  }
}

import { MCPClient } from "@mastra/mcp";
import type { MastraMCPServerDefinition } from "@mastra/mcp";
import type { Tool } from "@mastra/core/tools";
import type { ProviderConfig, ProviderRole } from "../config/schema.js";

export interface MastraProvider {
  name: string;
  roles: ProviderRole[];
  client: MCPClient;
  enabledTools?: string[];
}

/**
 * Build a MastraMCPServerDefinition from a ProviderConfig's mcpServer block.
 * The @mastra/mcp MCPClient takes a `servers` record where:
 *   - stdio transport → { command, args, env }
 *   - http transport  → { url: URL }
 */
function buildServerDefinition(config: ProviderConfig): MastraMCPServerDefinition {
  const { mcpServer } = config;
  if (mcpServer.transport === "http") {
    return { url: new URL(mcpServer.url) };
  }
  // stdio
  return {
    command: mcpServer.command,
    args: mcpServer.args,
    env: mcpServer.env,
  };
}

/**
 * Create a MastraProvider from a ProviderConfig.
 * Each provider wraps a single MCPClient instance configured for that provider's server.
 */
export function createMcpProvider(config: ProviderConfig): MastraProvider {
  const serverDef = buildServerDefinition(config);
  const client = new MCPClient({
    id: `provider-${config.name}`,
    servers: {
      [config.name]: serverDef,
    },
  });

  return {
    name: config.name,
    roles: config.roles,
    client,
    enabledTools: config.mcpServer.enabledTools,
  };
}

function filterToolsForProvider(provider: MastraProvider, tools: Record<string, Tool>): Record<string, Tool> {
  if (provider.enabledTools === undefined) return tools;
  if (provider.enabledTools.length === 0) return {};

  const enabled = new Set(provider.enabledTools);
  const filtered: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const unprefixed = name.startsWith(`${provider.name}_`)
      ? name.slice(provider.name.length + 1)
      : name;
    if (enabled.has(name) || enabled.has(unprefixed)) {
      filtered[name] = tool;
    }
  }
  return filtered;
}

export async function listProviderTools(provider: MastraProvider): Promise<Record<string, Tool>> {
  const tools = await provider.client.listTools();
  return filterToolsForProvider(provider, tools);
}

/**
 * Return all tools from providers that declare the given role.
 * Tools are returned as a flat merged record (namespaced by @mastra/mcp: serverName_toolName).
 */
export async function getToolsByRole(
  providers: MastraProvider[],
  role: ProviderRole,
): Promise<Record<string, Tool>> {
  const matching = providers.filter((p) => p.roles.includes(role));
  const toolMaps = await Promise.all(matching.map((p) => listProviderTools(p)));

  const merged: Record<string, Tool> = {};
  for (const tools of toolMaps) {
    Object.assign(merged, tools);
  }
  return merged;
}

/**
 * Return all tools from all providers as a flat merged record.
 */
export async function getAllTools(providers: MastraProvider[]): Promise<Record<string, Tool>> {
  const toolMaps = await Promise.all(providers.map((p) => listProviderTools(p)));

  const merged: Record<string, Tool> = {};
  for (const tools of toolMaps) {
    Object.assign(merged, tools);
  }
  return merged;
}

import { MCPClient } from "@mastra/mcp";
import type { MastraMCPServerDefinition } from "@mastra/mcp";
import type { Tool } from "@mastra/core/tools";
import type { ProviderConfig, ProviderRole } from "../config/schema.js";

export interface MastraProvider {
  name: string;
  roles: ProviderRole[];
  client: MCPClient;
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
  };
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
  const toolMaps = await Promise.all(matching.map((p) => p.client.listTools()));

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
  const toolMaps = await Promise.all(providers.map((p) => p.client.listTools()));

  const merged: Record<string, Tool> = {};
  for (const tools of toolMaps) {
    Object.assign(merged, tools);
  }
  return merged;
}

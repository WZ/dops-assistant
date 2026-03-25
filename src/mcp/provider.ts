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

// ── Tool Classification ──────────────────────────────────────────────────────

const READ_PREFIXES = [
  "get_", "list_", "search_", "query_",
  "read_", "find_", "describe_", "check_",
  "fetch_", "lookup_", "count_", "show_",
];

// Keywords for tools that use entity_verb naming (e.g., pods_list, nodes_log, resources_get)
// Matched as _keyword_ or _keyword at end of name
const READ_KEYWORDS = [
  "get", "list", "log", "logs", "view",
  "show", "stats", "summary", "top",
  "search", "query", "describe", "check",
];

// Full names that are read-only but don't match prefix/suffix patterns
const READ_EXACT = new Set([
  "configuration_view",
]);

/**
 * Classify a tool as read-only or write based on its name.
 * Checks prefixes (list_pods), suffixes (pods_list), and exact matches.
 * Unknown patterns default to "write" (safe default).
 */
export function classifyToolAccess(toolName: string): "read" | "write" {
  const lower = toolName.toLowerCase();
  if (READ_EXACT.has(lower)) return "read";
  if (READ_PREFIXES.some(p => lower.startsWith(p))) return "read";
  // Check for read keywords as segments: _keyword_ or _keyword at end
  const segments = lower.split("_");
  if (segments.some(s => READ_KEYWORDS.includes(s))) return "read";
  return "write";
}

/**
 * List ALL tools from a provider without applying enabledTools filter.
 * Used by the tool management UI to show the complete tool inventory.
 */
export async function listAllProviderTools(provider: MastraProvider): Promise<Record<string, Tool>> {
  return provider.client.listTools();
}

export interface ToolInfo {
  name: string;
  description: string;
  readOnly: boolean;
  enabled: boolean;
}

/**
 * Get tools with metadata (classification + enabled status) for a provider.
 */
export async function getToolsWithMetadata(provider: MastraProvider): Promise<ToolInfo[]> {
  const allTools = await listAllProviderTools(provider);
  // undefined = no config (all enabled), [] = explicit empty (all disabled), [...] = specific tools enabled
  const enabledSet = provider.enabledTools === undefined
    ? null
    : new Set(provider.enabledTools);

  return Object.entries(allTools).map(([namespacedName, tool]) => {
    const rawName = namespacedName.startsWith(`${provider.name}_`)
      ? namespacedName.slice(provider.name.length + 1)
      : namespacedName;

    const readOnly = classifyToolAccess(rawName) === "read";
    const enabled = enabledSet === null
      ? true
      : enabledSet.has(rawName) || enabledSet.has(namespacedName);

    return {
      name: rawName,
      description: (tool as any).description ?? "",
      readOnly,
      enabled,
    };
  });
}

/**
 * Compute default enabledTools list: all read-only tools.
 */
export function computeDefaultEnabledTools(tools: Record<string, Tool>, providerName: string): string[] {
  return Object.keys(tools)
    .map(name => name.startsWith(`${providerName}_`) ? name.slice(providerName.length + 1) : name)
    .filter(name => classifyToolAccess(name) === "read");
}

// DEPRECATED: Use Mastra equivalents. Will be removed when USE_MASTRA migration is complete.
import type { McpClient, OpenAITool, ToolResult } from "./client.js";
import type { ProviderRole } from "../config/schema.js";

export interface ProviderEntry {
  name: string;
  roles: ProviderRole[];
  client: McpClient;
}

/**
 * Ownership record stored per tool — tracks which provider owns it
 * and the original (un-prefixed) tool name used by the underlying McpClient.
 */
interface ToolOwner {
  provider: ProviderEntry;
  originalName: string;
}

/**
 * Wraps N McpClient instances, merges their tool lists, routes callTool()
 * to the correct owner, and provides role-based queries.
 */
export class MultiMcpClient {
  private readonly providers: ProviderEntry[];
  private toolOwnership: Map<string, ToolOwner> = new Map();
  private mergedTools: OpenAITool[] = [];

  constructor(providers: ProviderEntry[]) {
    this.providers = providers;
  }

  /**
   * Build the tool index from all connected providers.
   * Detects name collisions and prefixes with `providerName__toolName` when needed.
   * Uses `__` as delimiter (OpenAI function names only allow `[a-zA-Z0-9_-]`).
   */
  private buildToolIndex(): void {
    // First pass: collect all tools grouped by name to detect collisions
    const toolsByName = new Map<string, { provider: ProviderEntry; tool: OpenAITool }[]>();

    for (const provider of this.providers) {
      for (const tool of provider.client.getTools()) {
        const name = tool.function.name;
        const existing = toolsByName.get(name) ?? [];
        existing.push({ provider, tool });
        toolsByName.set(name, existing);
      }
    }

    // Second pass: build the merged list and ownership map
    this.mergedTools = [];
    this.toolOwnership = new Map();

    for (const [name, entries] of toolsByName) {
      if (entries.length === 1) {
        // No collision — use the original name
        const { provider, tool } = entries[0];
        this.mergedTools.push(tool);
        this.toolOwnership.set(name, { provider, originalName: name });
      } else {
        // Collision — prefix each with provider name
        for (const { provider, tool } of entries) {
          const prefixedName = `${provider.name}__${name}`;
          const prefixedTool: OpenAITool = {
            type: "function",
            function: {
              ...tool.function,
              name: prefixedName,
            },
          };
          this.mergedTools.push(prefixedTool);
          this.toolOwnership.set(prefixedName, { provider, originalName: name });
        }
      }
    }
  }

  /** Connects all providers in parallel, then builds the tool index. Rolls back on partial failure. */
  async connect(): Promise<void> {
    const results = await Promise.allSettled(this.providers.map((p) => p.client.connect()));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      // Disconnect any that succeeded before throwing
      await Promise.allSettled(
        this.providers
          .filter((_, i) => results[i].status === "fulfilled")
          .map((p) => p.client.disconnect()),
      );
      const reasons = failed.map((f) => (f as PromiseRejectedResult).reason);
      throw new AggregateError(reasons, `${failed.length}/${this.providers.length} provider(s) failed to connect`);
    }
    this.buildToolIndex();
  }

  /** Disconnects all providers. */
  async disconnect(): Promise<void> {
    await Promise.all(this.providers.map((p) => p.client.disconnect()));
    this.mergedTools = [];
    this.toolOwnership = new Map();
  }

  /** Returns true only if ALL providers are connected. */
  isConnected(): boolean {
    return this.providers.every((p) => p.client.isConnected());
  }

  /** Returns the merged tool list from all providers. */
  getTools(): OpenAITool[] {
    return this.mergedTools;
  }

  /** Routes a tool call to the owning provider, stripping prefix if needed. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const owner = this.toolOwnership.get(name);
    if (!owner) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return owner.provider.client.callTool(owner.originalName, args);
  }

  /** Returns providers that declared the given role. */
  getProvidersByRole(role: ProviderRole): ProviderEntry[] {
    return this.providers.filter((p) => p.roles.includes(role));
  }

  /** Returns tools from providers that declared the given role. */
  getToolsByRole(role: ProviderRole): OpenAITool[] {
    const roleProviders = new Set(
      this.getProvidersByRole(role).map((p) => p.name),
    );
    return this.mergedTools.filter((tool) => {
      const owner = this.toolOwnership.get(tool.function.name);
      return owner !== undefined && roleProviders.has(owner.provider.name);
    });
  }

  /** Returns true if any provider has the given role. */
  hasRole(role: ProviderRole): boolean {
    return this.providers.some((p) => p.roles.includes(role));
  }
}

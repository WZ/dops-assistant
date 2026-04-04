import { existsSync, readFileSync, writeFileSync } from "fs";
import { parse, stringify } from "yaml";
import { ProviderSchema, type ProviderConfig, type ProviderRole } from "../config/schema.js";
import {
  createMcpProvider,
  listProviderTools,
  listAllProviderTools,
  getToolsWithMetadata,
  computeDefaultEnabledTools,
  type MastraProvider,
  type ToolInfo,
} from "./provider.js";
import { z } from "zod";

export interface ProviderInfo {
  provider: MastraProvider;
  config: ProviderConfig;
  source: "config" | "gui";
  status: "connected" | "error" | "unknown";
  toolCount: number;
  enabledToolCount: number;
  error?: string;
}

const GuiProvidersSchema = z.array(ProviderSchema);

export class ProviderRegistry {
  private entries: Map<string, ProviderInfo> = new Map();
  private configProviders: ProviderConfig[];
  private providersFilePath: string;

  constructor(configProviders: ProviderConfig[], providersFilePath: string) {
    this.configProviders = configProviders;
    this.providersFilePath = providersFilePath;
  }

  /**
   * Initialize all providers (called once at startup).
   * Creates MCP clients for config.yaml and providers.yaml providers,
   * tests each connection, and sets initial status.
   */
  async initialize(): Promise<void> {
    // Load config providers (read-only)
    for (const config of this.configProviders) {
      await this.createAndRegister(config, "config");
    }

    // Load GUI providers from providers.yaml
    const guiProviders = this.loadGuiProviders();
    for (const config of guiProviders) {
      // Skip if name conflicts with a config provider (config wins)
      if (this.entries.has(config.name)) continue;
      await this.createAndRegister(config, "gui");
    }
  }

  /**
   * Add a new GUI provider. Validates uniqueness, creates MCP client,
   * tests connection, persists to providers.yaml.
   */
  async add(config: ProviderConfig): Promise<ProviderInfo> {
    if (this.entries.has(config.name)) {
      throw new Error("Provider name already exists");
    }

    const info = await this.createAndRegister(config, "gui");
    this.saveGuiProviders();
    return info;
  }

  /**
   * Remove a GUI provider. Config providers cannot be removed.
   */
  async remove(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error("Provider not found");
    }
    if (entry.source === "config") {
      throw new Error("Cannot remove system provider");
    }

    this.entries.delete(name);
    this.saveGuiProviders();
  }

  /**
   * Update a GUI provider. Config providers cannot be updated.
   * Removes old provider and adds new one with the updated config.
   */
  async update(name: string, config: ProviderConfig): Promise<ProviderInfo> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error("Provider not found");
    }
    if (entry.source === "config") {
      throw new Error("Cannot update system provider");
    }

    // Remove old entry
    this.entries.delete(name);

    // If the name changed, check for conflicts
    if (config.name !== name && this.entries.has(config.name)) {
      // Restore old entry before throwing
      this.entries.set(name, entry);
      throw new Error("Provider name already exists");
    }

    const info = await this.createAndRegister(config, "gui");
    this.saveGuiProviders();
    return info;
  }

  /**
   * Return all ProviderInfo entries (config + GUI).
   */
  getAll(): ProviderInfo[] {
    return Array.from(this.entries.values());
  }

  /**
   * Return MastraProvider[] for providers matching the given role.
   */
  getByRole(role: ProviderRole): MastraProvider[] {
    return Array.from(this.entries.values())
      .filter((info) => info.provider.roles.includes(role))
      .map((info) => info.provider);
  }

  /**
   * Return flat MastraProvider[] for backward compatibility.
   */
  getProviders(): MastraProvider[] {
    return Array.from(this.entries.values()).map((info) => info.provider);
  }

  /**
   * Test connection for a named provider. Updates status in the registry.
   */
  async test(name: string): Promise<{ status: "ok" | "error"; toolCount: number; error?: string }> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error("Provider not found");
    }

    try {
      const tools = await listProviderTools(entry.provider);
      const toolCount = Object.keys(tools).length;
      entry.status = "connected";
      entry.toolCount = toolCount;
      entry.error = undefined;

      // Re-run auto-compute if initial registration failed before defaults were set
      if (!entry.provider.enabledTools?.length && toolCount > 0) {
        const allRawTools = await listAllProviderTools(entry.provider);
        const defaults = computeDefaultEnabledTools(allRawTools, entry.config.name);
        entry.provider.enabledTools = defaults;
      }
      entry.enabledToolCount = entry.provider.enabledTools?.length ?? toolCount;

      return { status: "ok", toolCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.status = "error";
      entry.error = message;
      return { status: "error", toolCount: 0, error: message };
    }
  }

  /**
   * Return all tools with metadata (classification + enabled status) for a named provider.
   */
  async getToolsForProvider(name: string): Promise<ToolInfo[]> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error("Provider not found");
    return getToolsWithMetadata(entry.provider);
  }

  /**
   * Update the enabled tools list for a named provider.
   * Only persists to providers.yaml for GUI providers.
   */
  async updateEnabledTools(name: string, enabledTools: string[]): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error("Provider not found");

    entry.provider.enabledTools = enabledTools;
    entry.config = {
      ...entry.config,
      mcpServer: { ...entry.config.mcpServer, enabledTools },
    };
    entry.enabledToolCount = enabledTools.length;

    if (entry.source === "gui") {
      this.saveGuiProviders();
    }
  }

  /**
   * Load GUI providers from providers.yaml.
   * Returns empty array if file doesn't exist or is invalid.
   */
  private loadGuiProviders(): ProviderConfig[] {
    if (!existsSync(this.providersFilePath)) return [];

    const raw = readFileSync(this.providersFilePath, "utf-8");
    const parsed = parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    const result = GuiProvidersSchema.safeParse(parsed);
    if (!result.success) return [];

    return result.data;
  }

  /**
   * Write only GUI providers to providers.yaml.
   */
  private saveGuiProviders(): void {
    const guiConfigs = Array.from(this.entries.values())
      .filter((info) => info.source === "gui")
      .map((info) => info.config);

    const header = "# Managed by dops-assistant GUI — do not edit manually\n";
    const body = guiConfigs.length > 0 ? stringify(guiConfigs, { indent: 2 }) : "";
    writeFileSync(this.providersFilePath, header + body);
  }

  /**
   * Create an MCP provider, test its connection, and register it.
   */
  private async createAndRegister(
    config: ProviderConfig,
    source: "config" | "gui",
  ): Promise<ProviderInfo> {
    let provider: MastraProvider;
    let status: ProviderInfo["status"] = "unknown";
    let toolCount = 0;
    let error: string | undefined;

    try {
      provider = createMcpProvider(config);
    } catch (err) {
      // If MCP client creation fails, create a stub so we can still track it
      const message = err instanceof Error ? err.message : String(err);
      const info: ProviderInfo = {
        provider: { name: config.name, roles: config.roles, client: {} as never },
        config,
        source,
        status: "error",
        toolCount: 0,
        enabledToolCount: 0,
        error: message,
      };
      this.entries.set(config.name, info);
      return info;
    }

    try {
      const tools = await listProviderTools(provider);
      toolCount = Object.keys(tools).length;
      status = "connected";
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    }

    // Auto-compute default enabledTools if not configured
    if (!provider.enabledTools?.length && toolCount > 0) {
      const allRawTools = await listAllProviderTools(provider);
      const defaults = computeDefaultEnabledTools(allRawTools, config.name);
      provider.enabledTools = defaults;
    }

    const info: ProviderInfo = {
      provider,
      config,
      source,
      status,
      toolCount,
      enabledToolCount: provider.enabledTools?.length ?? toolCount,
      error,
    };

    this.entries.set(config.name, info);
    return info;
  }
}

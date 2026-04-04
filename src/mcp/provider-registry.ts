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
import pino from "pino";
import { z } from "zod";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

/**
 * Resolve the Prometheus datasource UID from a metrics provider's tool set.
 * Called during initialization when the MCP session is fresh.
 */
async function resolvePrometheusDatasourceUid(tools: Record<string, unknown>): Promise<string | undefined> {
  const listDsTool = Object.entries(tools).find(
    ([name]) => name.includes("list_datasource") || name.includes("list_datasources"),
  ) ?? Object.entries(tools).find(
    ([name]) => name.includes("datasource") && !name.includes("get_datasource"),
  );
  if (!listDsTool) return undefined;
  try {
    const result = await (listDsTool[1] as { execute: (args: unknown) => Promise<unknown> }).execute({});
    const outer = typeof result === "object" && result !== null ? result : undefined;
    if (!outer || (outer as any)?.isError) return undefined;
    const textContent = (outer as any)?.content?.[0]?.text;
    if (!textContent || typeof textContent !== "string") return undefined;
    let data: unknown;
    try { data = JSON.parse(textContent); } catch { return undefined; }
    const datasources = Array.isArray(data) ? data : (data as any)?.datasources ?? [];
    const prom = datasources.find((ds: Record<string, unknown>) =>
      ds.type === "prometheus" || (ds.name as string)?.toLowerCase().includes("prometheus") || (ds.name as string)?.toLowerCase().includes("metric"),
    );
    if (prom?.uid) {
      logger.info({ uid: prom.uid, name: prom.name }, "ProviderRegistry: resolved Prometheus datasource UID");
      return prom.uid as string;
    }
  } catch { /* non-fatal */ }
  return undefined;
}

export interface ProviderInfo {
  provider: MastraProvider;
  config: ProviderConfig;
  source: "config" | "gui";
  status: "connected" | "error" | "unknown";
  toolCount: number;
  enabledToolCount: number;
  error?: string;
  /** Cached Prometheus datasource UID, resolved at initialization for metrics-role providers. */
  prometheusDatasourceUid?: string;
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

      // Resolve Prometheus datasource UID if not yet cached (session is fresh after successful test)
      if (!entry.prometheusDatasourceUid && entry.config.roles.includes("metrics") && toolCount > 0) {
        const allRawTools = await listAllProviderTools(entry.provider);
        entry.prometheusDatasourceUid = await resolvePrometheusDatasourceUid(allRawTools);
      }

      // Smoke test: execute a lightweight read-only tool to verify end-to-end connectivity
      const allTools = await listAllProviderTools(entry.provider);
      const smokeError = await this.smokeTestTool(allTools);
      if (smokeError) {
        entry.status = "error";
        entry.error = smokeError;
        return { status: "error", toolCount, error: smokeError };
      }

      return { status: "ok", toolCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.status = "error";
      entry.error = message;
      return { status: "error", toolCount: 0, error: message };
    }
  }

  /**
   * Execute a lightweight read-only tool to verify the upstream service is reachable and authenticated.
   * Returns an error message if the tool call fails, or undefined if it succeeds.
   */
  private async smokeTestTool(tools: Record<string, unknown>): Promise<string | undefined> {
    // Pick a lightweight tool: prefer list_datasources, namespaces_list, or any "list" tool
    const candidates = ["list_datasources", "namespaces_list", "list_namespaces"];
    let smokeTool: { execute: (args: unknown) => Promise<unknown> } | undefined;
    for (const [name, tool] of Object.entries(tools)) {
      if (candidates.some(c => name.includes(c))) {
        smokeTool = tool as any;
        break;
      }
    }
    if (!smokeTool) {
      // Fall back to any tool with "list" in the name
      for (const [name, tool] of Object.entries(tools)) {
        if (name.includes("list")) {
          smokeTool = tool as any;
          break;
        }
      }
    }
    if (!smokeTool) return undefined; // No suitable tool, skip smoke test

    try {
      const result = await smokeTool.execute({});
      const content = (result as any)?.content?.[0];
      if ((result as any)?.isError || content?.text?.includes("Unauthorized") || content?.text?.includes("401")) {
        return `Tool execution failed: ${content?.text?.slice(0, 120) ?? "unknown error"}`;
      }
      return undefined; // Success
    } catch (err) {
      return `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
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

    // Resolve Prometheus datasource UID for metrics-role providers (session is fresh here)
    let prometheusDatasourceUid: string | undefined;
    if (config.roles.includes("metrics") && toolCount > 0) {
      try {
        const allTools = await listAllProviderTools(provider);
        prometheusDatasourceUid = await resolvePrometheusDatasourceUid(allTools);
      } catch { /* non-fatal */ }
    }

    const info: ProviderInfo = {
      provider,
      config,
      source,
      status,
      toolCount,
      enabledToolCount: provider.enabledTools?.length ?? toolCount,
      error,
      prometheusDatasourceUid,
    };

    this.entries.set(config.name, info);
    return info;
  }
}

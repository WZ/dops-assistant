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
import { createLogger } from "../logger.js";
import { z } from "zod";

/**
 * Heuristic: decide whether a given tool name looks like a Prometheus-style
 * metric query tool. Mirrors `ServiceHealthPoller.findMetricQueryTool` so the
 * init-time poller gate can answer "does this stack have a tool we could
 * actually poll with?" without having to set up the full poller machinery.
 */
export function isMetricQueryToolName(name: string): boolean {
  if (name.endsWith("query_prometheus") || name.endsWith("get_metrics")) return true;
  const lower = name.toLowerCase();
  if (lower.includes("loki") || lower.includes("log") || lower.includes("metadata")) return false;
  return lower.includes("query") || lower.includes("metric");
}

const logger = createLogger();

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

function enabledToolNamesForProvider(provider: MastraProvider, toolNames: string[]): string[] {
  if (provider.enabledTools === undefined) return toolNames;
  if (provider.enabledTools.length === 0) return [];

  const enabled = new Set(provider.enabledTools);
  return toolNames.filter((name) => {
    const unprefixed = name.startsWith(`${provider.name}_`)
      ? name.slice(provider.name.length + 1)
      : name;
    return enabled.has(name) || enabled.has(unprefixed);
  });
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
  /**
   * Enabled tool names (post-namespacing by mastra) discovered during
   * init/test. Cached so the StackManager init-time poller gate can cheaply
   * ask "does this provider expose an enabled metric query tool?" without
   * re-calling the MCP server. Undefined = not yet probed; empty array =
   * probed and no enabled tools are available.
   */
  toolNames?: string[];
}

/**
 * Event payload for ProviderRegistry change notifications. `kind` describes
 * what just happened; `name` is the provider that changed. Consumers (like
 * StackManager) subscribe to know when a previously-skipped poller might now
 * be startable.
 */
export type ProviderRegistryChangeEvent = {
  kind: "add" | "update" | "remove" | "test";
  name: string;
};

export type ProviderRegistryListener = (event: ProviderRegistryChangeEvent) => void;

const GuiProvidersSchema = z.array(ProviderSchema);

export class ProviderRegistry {
  private entries: Map<string, ProviderInfo> = new Map();
  private configProviders: ProviderConfig[];
  private providersFilePath: string;
  private connectTimeoutMs: number | undefined;
  private listeners: Set<ProviderRegistryListener> = new Set();

  constructor(configProviders: ProviderConfig[], providersFilePath: string, connectTimeoutMs?: number) {
    this.configProviders = configProviders;
    this.providersFilePath = providersFilePath;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  /**
   * Subscribe to registry change events. Returns an unsubscribe function.
   * Used by StackManager to kick off previously-skipped health pollers when
   * a viable metrics provider is added or becomes healthy.
   */
  onChange(listener: ProviderRegistryListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: ProviderRegistryChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn({ err, event }, "ProviderRegistry: listener threw");
      }
    }
  }

  /**
   * True when at least one registered provider holds the `metrics` role,
   * is in `connected` status, has non-zero toolCount, and exposes at least
   * one tool whose name looks like a metric query tool.
   *
   * The StackManager uses this at boot (and on registry change events) to
   * decide whether it's worth running the health poller. Legacy stacks
   * whose providers all fail to connect would otherwise poll every 60s and
   * log "metric query tool not found, skipping poll" forever — filtering at
   * the gate silences that noise until a viable provider appears.
   */
  hasViableMetricsProvider(): boolean {
    for (const info of this.entries.values()) {
      if (!info.config.roles.includes("metrics")) continue;
      if (info.status !== "connected") continue;
      if (info.toolCount <= 0) continue;
      const names = info.toolNames ?? [];
      if (names.some(isMetricQueryToolName)) return true;
    }
    return false;
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
    this.emit({ kind: "add", name: config.name });
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
    this.emit({ kind: "remove", name });
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
    this.emit({ kind: "update", name: config.name });
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
      let toolCount = Object.keys(tools).length;
      let rawToolNames = Object.keys(tools);
      let allRawTools: Awaited<ReturnType<typeof listAllProviderTools>> | undefined;

      // Same reasoning as createAndRegister: 0 raw tools after a
      // "successful" listTools means @mastra/mcp swallowed a connection
      // failure. A filtered result can also be empty when the user has
      // intentionally disabled every tool, so fall back to the raw tool list
      // before declaring the provider unreachable.
      if (toolCount === 0 || entry.provider.enabledTools !== undefined) {
        allRawTools = await listAllProviderTools(entry.provider);
        rawToolNames = Object.keys(allRawTools);
        toolCount = rawToolNames.length;
        if (toolCount === 0) {
          const message = "MCP server returned no tools (likely unreachable or misconfigured)";
          entry.status = "error";
          entry.toolCount = 0;
          entry.error = message;
          entry.enabledToolCount = 0;
          entry.toolNames = [];
          this.emit({ kind: "test", name });
          return { status: "error", toolCount: 0, error: message };
        }
      }

      entry.status = "connected";
      entry.error = undefined;
      entry.toolNames = enabledToolNamesForProvider(entry.provider, rawToolNames);

      // Re-run auto-compute after a successful (re)connect so enabledTools stays in sync
      // with the current tool set. Previously this was gated on "initial registration
      // had no tools", which meant reconnecting a provider whose tool set changed left
      // enabledTools pointing at stale tool names — surfaced in the UI as
      // "0 tools (41 enabled)" or tools silently dropping out of rotation.
      // (Regression: provider-registry-stale-enabledToolCount.)
      if (toolCount > 0 && entry.provider.enabledTools?.length !== 0) {
        // Preserve any user-curated enabledTools that still exist in the fresh tool set;
        // fall back to defaults when none of the previous selections survive the reconnect.
        allRawTools ??= await listAllProviderTools(entry.provider);
        rawToolNames = Object.keys(allRawTools);
        toolCount = rawToolNames.length;
        const freshToolNames = new Set(rawToolNames);
        const previousEnabled = entry.provider.enabledTools ?? [];
        const survivors = previousEnabled.filter((n) =>
          freshToolNames.has(n) || freshToolNames.has(`${entry.config.name}_${n}`)
        );
        if (survivors.length > 0) {
          entry.provider.enabledTools = survivors;
        } else {
          entry.provider.enabledTools = computeDefaultEnabledTools(allRawTools, entry.config.name);
        }
      }
      entry.toolCount = toolCount;
      entry.toolNames = enabledToolNamesForProvider(entry.provider, rawToolNames);
      entry.enabledToolCount = entry.toolNames.length;

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
        this.emit({ kind: "test", name });
        return { status: "error", toolCount, error: smokeError };
      }

      this.emit({ kind: "test", name });
      return { status: "ok", toolCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.status = "error";
      entry.error = message;
      this.emit({ kind: "test", name });
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
      provider = createMcpProvider(config, this.connectTimeoutMs);
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

    let toolNames: string[] = [];
    try {
      const tools = await listProviderTools(provider);
      toolCount = Object.keys(tools).length;
      toolNames = Object.keys(tools);
      status = "connected";
      if (toolCount === 0 || provider.enabledTools !== undefined) {
        const rawTools = await listAllProviderTools(provider);
        const rawToolNames = Object.keys(rawTools);
        toolCount = rawToolNames.length;
        toolNames = enabledToolNamesForProvider(provider, rawToolNames);
      }
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    }

    // @mastra/mcp's MCPClient.listTools() catches per-server connection
    // failures and silently returns {} (see node_modules/@mastra/mcp/dist/
    // index.js around `async listTools()` — the catch block logs and moves
    // on). So "connected with 0 raw tools" is almost always an unreachable
    // upstream, not a working server. Reclassify it as an error so the UI dot
    // turns red, the chat short-circuit fires, and downstream code stops
    // operating on an empty tool set thinking it succeeded.
    if (status === "connected" && toolCount === 0) {
      status = "error";
      error = "MCP server returned no tools (likely unreachable or misconfigured)";
    }

    // Auto-compute default enabledTools if not configured
    if (provider.enabledTools === undefined && toolCount > 0) {
      const allRawTools = await listAllProviderTools(provider);
      const defaults = computeDefaultEnabledTools(allRawTools, config.name);
      provider.enabledTools = defaults;
      toolNames = enabledToolNamesForProvider(provider, Object.keys(allRawTools));
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
      enabledToolCount: toolNames.length,
      error,
      prometheusDatasourceUid,
      toolNames,
    };

    this.entries.set(config.name, info);
    return info;
  }
}

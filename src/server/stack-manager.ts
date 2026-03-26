/**
 * StackManager — lifecycle manager for multi-stack support.
 *
 * Each stack gets its own isolated StackContext containing:
 *   - ProviderRegistry (MCP providers)
 *   - ConversationMemory (chat history)
 *   - ServiceRegistryStore (discovered services)
 *   - ServiceHealthPoller (background health checks)
 *
 * The StackManager handles initialization, creation, deletion, and
 * provides context resolution for request handling.
 *
 * Key design decisions:
 *   - Agents are NOT in StackContext — created lazily in Phase 3 (Fix 1)
 *   - InvestigationDedup is NOT per-stack — remains a global singleton
 *   - Non-default stacks use /dev/null as providersFilePath (Fix 3)
 *   - Service registries: data/{slug}/services.yaml
 *   - Health pollers stagger start with random 0-30s delay
 */

import { mkdirSync } from "fs";
import { join, dirname } from "path";
import pino from "pino";
import { ulid } from "ulid";

import type { Config } from "../config/schema.js";
import { ProviderRegistry } from "../mcp/provider-registry.js";
import { ConversationMemory } from "../memory/conversation.js";
import { ServiceRegistryStore } from "../services/registry.js";
import { ServiceHealthPoller, type HealthStatus } from "./service-health-poller.js";
import type { Database } from "./db.js";
import type { StackRow, StackSummary, StackConfig } from "../types/stack-types.js";
import { DEFAULT_STACK_SLUG } from "../types/stack-types.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export interface StackContext {
  id: string;
  slug: string;
  name: string;
  providerRegistry: ProviderRegistry;
  conversationMemory: ConversationMemory;
  serviceRegistry: ServiceRegistryStore;
  healthPoller: ServiceHealthPoller;
}

export class StackManager {
  private stacks: Map<string, StackContext> = new Map();
  private db: Database;
  private config: Config;
  private defaultStackId: string | null = null;

  constructor(db: Database, config: Config) {
    this.db = db;
    this.config = config;
  }

  /**
   * Initialize the StackManager:
   * 1. Find or create the default stack from config.providers
   * 2. Backfill existing data with the default stack ID
   * 3. Initialize all stacks from DB
   */
  async initialize(): Promise<void> {
    // 1. Find or create default stack
    const existingDefault = this.db.getStackBySlug(DEFAULT_STACK_SLUG);

    if (existingDefault) {
      this.defaultStackId = existingDefault.id;
      logger.info({ stackId: existingDefault.id }, "StackManager: found existing default stack");
    } else {
      const id = ulid();
      const stackConfig: StackConfig = { providers: this.config.providers };
      this.db.createStack({
        id,
        name: "Default",
        slug: DEFAULT_STACK_SLUG,
        config: JSON.stringify(stackConfig),
      });
      this.defaultStackId = id;
      logger.info({ stackId: id }, "StackManager: created default stack");
    }

    // 2. Backfill existing data with default stack ID
    this.db.backfillDefaultStack(this.defaultStackId);

    // 3. Initialize all stacks from DB
    const rows = this.db.listStacks();
    for (const row of rows) {
      await this.initializeStack(row);
    }

    logger.info(
      { stackCount: this.stacks.size, defaultStackId: this.defaultStackId },
      "StackManager: initialization complete",
    );
  }

  /**
   * Initialize a single stack from its DB row.
   * Creates all per-stack dependencies and stores them in the stacks map.
   */
  private async initializeStack(row: StackRow): Promise<StackContext> {
    const stackConfig = JSON.parse(row.config) as StackConfig;
    const isDefault = row.id === this.defaultStackId;

    // ProviderRegistry: non-default stacks use /dev/null to prevent file corruption (Fix 3)
    const providersFilePath = isDefault
      ? join(dirname(process.cwd()), "providers.yaml")
      : "/dev/null";
    const providerRegistry = new ProviderRegistry(
      isDefault ? this.config.providers : stackConfig.providers,
      providersFilePath,
    );
    await providerRegistry.initialize();

    // ConversationMemory: per-stack, uses config defaults
    const memOpts = this.config.agent?.conversationMemory ?? { maxMessages: 50, ttlMinutes: 30 };
    const conversationMemory = new ConversationMemory({
      maxMessages: memOpts.maxMessages,
      ttlMinutes: memOpts.ttlMinutes,
    });

    // ServiceRegistryStore: per-stack path data/{slug}/services.yaml
    const servicesDir = join("data", row.slug);
    mkdirSync(servicesDir, { recursive: true });
    const serviceRegistry = new ServiceRegistryStore(join(servicesDir, "services.yaml"));

    // ServiceHealthPoller: per-stack with staggered start offset (0-30s)
    const healthPoller = new ServiceHealthPoller({
      providers: () => providerRegistry.getProviders(),
      registryStore: serviceRegistry,
      db: this.db,
      stackId: row.id,
      onTransition: (service: string, from: HealthStatus, to: HealthStatus) => {
        this.onHealthTransition?.(row.id, service, from, to);
      },
      getHiddenServices: () => this.db.getHiddenServices(row.id),
    });

    const ctx: StackContext = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      providerRegistry,
      conversationMemory,
      serviceRegistry,
      healthPoller,
    };

    this.stacks.set(row.id, ctx);
    return ctx;
  }

  /**
   * Get the StackContext for a given stack ID.
   * Throws if the stack does not exist.
   */
  getContext(stackId: string): StackContext {
    const ctx = this.stacks.get(stackId);
    if (!ctx) {
      throw new Error(`Stack not found: ${stackId}`);
    }
    return ctx;
  }

  /**
   * Get the default StackContext.
   */
  getDefaultContext(): StackContext {
    if (!this.defaultStackId) {
      throw new Error("StackManager not initialized");
    }
    return this.getContext(this.defaultStackId);
  }

  /**
   * Get the default stack ID.
   */
  getDefaultStackId(): string {
    if (!this.defaultStackId) {
      throw new Error("StackManager not initialized");
    }
    return this.defaultStackId;
  }

  /**
   * Resolve a stack ID from a potentially null/undefined/invalid value.
   * Falls back to the default stack if the value is not a valid stack ID.
   */
  resolveStackId(stackId?: string | null): string {
    if (stackId && this.stacks.has(stackId)) {
      return stackId;
    }
    return this.getDefaultStackId();
  }

  /**
   * Create a new stack with the given name, slug, and config.
   * Persists to DB, initializes all per-stack dependencies, and returns the context.
   */
  async createStack(name: string, slug: string, config: StackConfig): Promise<StackContext> {
    // Check for duplicate slug
    const existing = this.db.getStackBySlug(slug);
    if (existing) {
      throw new Error(`Stack with slug "${slug}" already exists`);
    }

    const id = ulid();
    const row: StackRow = {
      id,
      name,
      slug,
      config: JSON.stringify(config),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.db.createStack({
      id,
      name,
      slug,
      config: JSON.stringify(config),
    });

    const dbRow = this.db.getStack(id);
    if (!dbRow) {
      throw new Error("Failed to create stack — DB row not found after insert");
    }

    return this.initializeStack(dbRow);
  }

  /**
   * Delete a stack and all associated data.
   * Cannot delete the default stack.
   * Stops health poller, destroys conversation memory, then cascades DB deletion.
   */
  async deleteStack(stackId: string): Promise<void> {
    if (stackId === this.defaultStackId) {
      throw new Error("Cannot delete the default stack");
    }

    const ctx = this.stacks.get(stackId);
    if (!ctx) {
      throw new Error(`Stack not found: ${stackId}`);
    }

    // Stop health poller
    ctx.healthPoller.stop();

    // Destroy conversation memory (clears eviction interval)
    ctx.conversationMemory.destroy();

    // Remove from in-memory map
    this.stacks.delete(stackId);

    // Cascade delete all stack data from DB
    this.db.deleteStack(stackId);

    logger.info({ stackId, slug: ctx.slug }, "StackManager: stack deleted");
  }

  /**
   * List all stacks with summary information.
   */
  listStacks(): StackSummary[] {
    const rows = this.db.listStacks();
    return rows.map((row) => {
      const ctx = this.stacks.get(row.id);
      const stackConfig = JSON.parse(row.config) as StackConfig;
      const healthSummary = ctx?.healthPoller.getSummary();

      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        isDefault: row.id === this.defaultStackId,
        healthSummary,
        providerCount: stackConfig.providers.length,
        createdAt: row.created_at,
      };
    });
  }

  /**
   * Start all health pollers with staggered delays (0-30s).
   */
  startAllPollers(): void {
    for (const ctx of this.stacks.values()) {
      const delay = Math.floor(Math.random() * 30_000);
      setTimeout(() => ctx.healthPoller.start(), delay);
    }
  }

  /**
   * Stop all health pollers.
   */
  stopAllPollers(): void {
    for (const ctx of this.stacks.values()) {
      ctx.healthPoller.stop();
    }
  }

  /**
   * Destroy all conversation memory instances (clears eviction timers).
   */
  destroyAllMemory(): void {
    for (const ctx of this.stacks.values()) {
      ctx.conversationMemory.destroy();
    }
  }

  /**
   * Optional callback for health status transitions.
   * Called with (stackId, service, fromStatus, toStatus) when a service
   * transitions between health states during polling.
   */
  onHealthTransition?: (stackId: string, service: string, from: string, to: string) => void;
}

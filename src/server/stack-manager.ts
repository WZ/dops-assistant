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
import { join } from "path";
import { createLogger } from "../logger.js";
import { ulid } from "ulid";

import type { Config } from "../config/schema.js";
import { getServicesFilePath } from "../config/loader.js";
import { ProviderRegistry } from "../mcp/provider-registry.js";
import { ConversationMemory } from "../memory/conversation.js";
import { ServiceRegistryStore } from "../services/registry.js";
import { ServiceHealthPoller, type HealthStatus } from "./service-health-poller.js";
import { ScanScheduler, type ScanAnomaliesEvent } from "./scan-scheduler.js";
import type { Database } from "./db.js";
import type { StackRow, StackSummary, StackConfig } from "../types/stack-types.js";
import { DEFAULT_STACK_SLUG } from "../types/stack-types.js";
import { clearStackCaches } from "./ws-handler.js";

const logger = createLogger();

export interface StackContext {
  id: string;
  slug: string;
  name: string;
  providerRegistry: ProviderRegistry;
  conversationMemory: ConversationMemory;
  serviceRegistry: ServiceRegistryStore;
  healthPoller: ServiceHealthPoller;
  scanScheduler: ScanScheduler;
}

export class StackManager {
  private stacks: Map<string, StackContext> = new Map();
  private db: Database;
  private config: Config;
  private defaultStackId: string | null = null;
  /**
   * Track which stacks had their poller intentionally skipped at init-time
   * because they had no viable metrics provider (issue #8). We keep the
   * entry so that when a provider is later added/tested/updated and the
   * registry fires a change event, we can start the poller on demand
   * instead of silently staying idle.
   */
  private skippedPollers: Set<string> = new Set();
  private allPollersStarted = false;
  private ttlReaperHandle: ReturnType<typeof setInterval> | undefined;

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

    // All stacks (including default) use data/{slug}/ for providers.yaml and services.yaml.
    // Default stack also merges config.yaml providers (read-only) with GUI providers.
    const stackDir = join("data", row.slug);
    mkdirSync(stackDir, { recursive: true });

    const providersFilePath = join(stackDir, "providers.yaml");
    const providerRegistry = new ProviderRegistry(
      isDefault ? this.config.providers : stackConfig.providers,
      providersFilePath,
      this.config.timeouts?.mcpConnectMs,
    );
    await providerRegistry.initialize();

    // ConversationMemory: per-stack, uses config defaults
    const memOpts = this.config.agent?.conversationMemory ?? { maxMessages: 50, ttlMinutes: 30 };
    const conversationMemory = new ConversationMemory({
      maxMessages: memOpts.maxMessages,
      ttlMinutes: memOpts.ttlMinutes,
    });

    // ServiceRegistryStore: all stacks use data/{slug}/services.yaml
    const serviceRegistry = new ServiceRegistryStore(join(stackDir, "services.yaml"));

    // ServiceHealthPoller: per-stack with staggered start offset (0-30s)
    // Prometheus datasource UID is resolved lazily from the provider registry
    // (may not be available at init if remote MCP timed out, resolves on first successful test/poll)
    const getDatasourceUid = () => providerRegistry.getAll().find(
      p => p.config.roles.includes("metrics") && p.prometheusDatasourceUid,
    )?.prometheusDatasourceUid;

    const healthPoller = new ServiceHealthPoller({
      providers: () => providerRegistry.getProviders(),
      registryStore: serviceRegistry,
      db: this.db,
      stackId: row.id,
      onTransition: (service: string, from: HealthStatus, to: HealthStatus) => {
        this.onHealthTransition?.(row.id, service, from, to);
      },
      getHiddenServices: () => this.db.getHiddenServices(row.id),
      getPrometheusDatasourceUid: getDatasourceUid,
    });

    // ScanScheduler: per-stack. Emits onAnomaliesDetected — the actual
    // dispatch to InvestigationRunner is wired in index.ts (lazy runner
    // construction matches the existing onHealthTransition pattern).
    const scanScheduler = new ScanScheduler({
      providers: () => providerRegistry.getProviders(),
      registryStore: serviceRegistry,
      db: this.db,
      stackId: row.id,
      scan: this.config.scan,
      getPrometheusDatasourceUid: getDatasourceUid,
      getHiddenServices: () => this.db.getHiddenServices(row.id),
      onAnomaliesDetected: (evt: ScanAnomaliesEvent) => {
        this.onScanAnomalies?.(evt);
      },
    });

    const ctx: StackContext = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      providerRegistry,
      conversationMemory,
      serviceRegistry,
      healthPoller,
      scanScheduler,
    };

    this.stacks.set(row.id, ctx);

    // Wire a listener so that if a provider is added / tested successfully
    // / updated on a stack whose poller was skipped at init, we can start
    // the poller on demand. Without this, a legacy stack with no viable
    // metrics provider would never poll until server restart even after
    // the user fixed its config.
    providerRegistry.onChange(() => {
      this.maybeStartSkippedPoller(row.id);
    });

    return ctx;
  }

  /**
   * If this stack's poller was skipped at boot because the registry had no
   * viable metrics provider, and we've since gained one, start it now.
   * No-op otherwise. Safe to call repeatedly.
   */
  private maybeStartSkippedPoller(stackId: string): void {
    if (!this.skippedPollers.has(stackId)) return;
    const ctx = this.stacks.get(stackId);
    if (!ctx) return;
    if (!ctx.providerRegistry.hasViableMetricsProvider()) return;
    this.skippedPollers.delete(stackId);
    logger.info(
      { stackId, slug: ctx.slug },
      "StackManager: starting previously-skipped health poller + scan scheduler — viable metrics provider became available",
    );
    ctx.healthPoller.start();
    ctx.scanScheduler.start();
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
    return this.resolveStackIdWithFallback(stackId).id;
  }

  /**
   * Like `resolveStackId` but also reports whether the caller's value was
   * rejected (invalid / missing) and we had to fall back to the default.
   * Lets callers surface the fallback as a debug log or response header so
   * users with a bookmarked URL for a since-deleted stack don't silently
   * view the wrong environment's data.
   */
  resolveStackIdWithFallback(stackId?: string | null): { id: string; fallback: boolean } {
    if (stackId && this.stacks.has(stackId)) {
      return { id: stackId, fallback: false };
    }
    return { id: this.getDefaultStackId(), fallback: Boolean(stackId) };
  }

  /**
   * Create a new stack with the given name, slug, and config.
   * Persists to DB, initializes all per-stack dependencies, and returns the context.
   */
  /** Slug must be 2-64 lowercase alphanumeric chars and hyphens, no leading/trailing hyphens */
  private static readonly SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

  async createStack(name: string, slug: string, config: StackConfig): Promise<StackContext> {
    // Defense-in-depth: validate slug to prevent path traversal via join("data", slug)
    if (!slug || !StackManager.SLUG_REGEX.test(slug) || slug.length > 64) {
      throw new Error("Invalid slug: must be 2-64 lowercase alphanumeric characters and hyphens");
    }

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

    const ctx = await this.initializeStack(dbRow);
    // Start the poller — startAllPollers() only runs at boot, so stacks created
    // after boot (via the GUI) would never poll without this. Gate on viable
    // metrics provider so freshly-created stacks with no working providers
    // don't immediately start spamming "metric query tool not found" logs.
    if (ctx.providerRegistry.hasViableMetricsProvider()) {
      ctx.healthPoller.start();
      ctx.scanScheduler.start();
    } else {
      this.skippedPollers.add(ctx.id);
      logger.info(
        { stackId: ctx.id, slug: ctx.slug },
        "StackManager: skipping health poller + scan scheduler start — no viable metrics provider yet (will auto-start when one is added/healthy)",
      );
    }
    return ctx;
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

    // Stop health poller + scan scheduler
    ctx.healthPoller.stop();
    ctx.scanScheduler.stop();

    // Destroy conversation memory (clears eviction interval)
    ctx.conversationMemory.destroy();

    // Remove from in-memory map
    this.stacks.delete(stackId);

    // Clear cached agents and metrics tool names
    clearStackCaches(stackId);

    // Cascade delete all stack data from DB
    this.db.deleteStack(stackId);

    logger.info({ stackId, slug: ctx.slug }, "StackManager: stack deleted");
  }

  /**
   * List all stacks with summary information. Excludes soft-deleted stacks
   * (those with `deleted_at` set by the TTL reaper).
   */
  listStacks(): StackSummary[] {
    const rows = this.db.listStacks();
    return rows.map((row) => {
      const ctx = this.stacks.get(row.id);
      const healthSummary = ctx?.healthPoller.getSummary();

      // providerCount reflects the live registry (includes GUI-added providers
      // persisted to providers.yaml). The DB row.config is only the initial seed
      // and is not updated when providers are added/removed via the GUI, so we
      // MUST NOT read from it here. Fall back to the seed only if the stack
      // hasn't been initialized yet.
      const providerCount = ctx
        ? ctx.providerRegistry.getAll().length
        : (JSON.parse(row.config) as StackConfig).providers.length;

      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        isDefault: row.id === this.defaultStackId,
        healthSummary,
        providerCount,
        createdAt: row.created_at,
        status: row.inactive_at ? "inactive" : "active",
        lastActiveAt: row.last_active_at,
      };
    });
  }

  /**
   * Record that this stack had some activity (tool call, successful poll,
   * webhook, UI nav). Bumps `last_active_at` in the DB and clears any
   * inactive marker. Safe to call frequently — it's a single UPDATE by PK.
   * Silently no-ops for unknown stack IDs.
   */
  bumpActivity(stackId: string): void {
    if (!this.stacks.has(stackId)) return;
    try {
      this.db.bumpStackActivity(stackId);
    } catch (err) {
      logger.warn({ err, stackId }, "StackManager: bumpStackActivity failed");
    }
  }

  /**
   * Default TTL thresholds. Exposed as constants so tests and the reaper
   * runner stay in sync; tune here if we ever change policy.
   */
  static readonly INACTIVE_AFTER_DAYS = 30;
  static readonly DELETE_AFTER_DAYS = 60;

  /**
   * Run the TTL reaper once. Marks stacks idle >30 days inactive and
   * soft-deletes those idle >60 days. After soft-delete we also tear down
   * the in-memory StackContext (stop poller, clear caches) so the now-dead
   * stack stops consuming resources. The default stack is exempted.
   *
   * Returns a summary for logging.
   */
  runTtlReaper(opts?: { nowIso?: string; inactiveAfterDays?: number; deleteAfterDays?: number }): {
    markedInactive: number;
    softDeleted: number;
  } {
    if (!this.defaultStackId) {
      return { markedInactive: 0, softDeleted: 0 };
    }
    const result = this.db.runStackTtlReaper({
      defaultStackId: this.defaultStackId,
      inactiveAfterDays: opts?.inactiveAfterDays ?? StackManager.INACTIVE_AFTER_DAYS,
      deleteAfterDays: opts?.deleteAfterDays ?? StackManager.DELETE_AFTER_DAYS,
      nowIso: opts?.nowIso,
    });

    // Tear down any in-memory contexts that just got soft-deleted. The DB
    // row is still present (soft-delete), but we shouldn't keep polling or
    // serving it. listStacks filters them out at the query level.
    if (result.softDeleted > 0) {
      const liveIds = new Set(this.db.listStacks().map(r => r.id));
      for (const [stackId, ctx] of Array.from(this.stacks.entries())) {
        if (!liveIds.has(stackId) && stackId !== this.defaultStackId) {
          try { ctx.healthPoller.stop(); } catch { /* ignore */ }
          try { ctx.scanScheduler.stop(); } catch { /* ignore */ }
          try { ctx.conversationMemory.destroy(); } catch { /* ignore */ }
          this.stacks.delete(stackId);
          this.skippedPollers.delete(stackId);
          clearStackCaches(stackId);
          logger.info({ stackId, slug: ctx.slug }, "StackManager: soft-deleted stack, tore down in-memory context");
        }
      }
    }

    if (result.markedInactive > 0 || result.softDeleted > 0) {
      logger.info(result, "StackManager: TTL reaper complete");
    }
    return result;
  }

  /**
   * Start all health pollers with staggered delays (0-30s). Stacks with no
   * viable metrics provider (see `ProviderRegistry.hasViableMetricsProvider`)
   * are skipped and recorded — they'll auto-start via a provider-change
   * listener when a working metrics provider is added or tested.
   *
   * This prevents the "metric query tool not found, skipping poll" log spam
   * from legacy stacks whose config still has 3 providers registered but
   * whose runtime toolCount is 0 (issue #8).
   */
  startAllPollers(): void {
    this.allPollersStarted = true;
    for (const ctx of this.stacks.values()) {
      if (!ctx.providerRegistry.hasViableMetricsProvider()) {
        this.skippedPollers.add(ctx.id);
        logger.info(
          { stackId: ctx.id, slug: ctx.slug },
          "StackManager: skipping health poller + scan scheduler start — no viable metrics provider (will auto-start when one becomes available)",
        );
        continue;
      }
      const pollerDelay = Math.floor(Math.random() * 30_000);
      setTimeout(() => ctx.healthPoller.start(), pollerDelay);
      // Scan scheduler uses a wider 0-60s jitter (design decision #5) to reduce
      // cross-stack cron collision when multiple stacks share "0 */4 * * *".
      const scanDelay = Math.floor(Math.random() * 60_000);
      setTimeout(() => ctx.scanScheduler.start(), scanDelay);
    }
  }

  /**
   * Stop all health pollers and scan schedulers.
   */
  stopAllPollers(): void {
    for (const ctx of this.stacks.values()) {
      ctx.healthPoller.stop();
      ctx.scanScheduler.stop();
    }
  }

  /**
   * Kick off a recurring TTL reaper. The reaper runs once immediately (so
   * post-deploy the DB state is up to date) and then every `intervalMs`.
   * Returns a handle for the tests; index.ts doesn't need it since
   * `destroyAllMemory` plus server shutdown tears it down.
   *
   * Default interval is 1 hour — TTL math is measured in days, so polling
   * more often is wasted work.
   */
  startTtlReaper(intervalMs = 60 * 60 * 1000): void {
    this.runTtlReaper();
    this.ttlReaperHandle = setInterval(() => {
      try {
        this.runTtlReaper();
      } catch (err) {
        logger.warn({ err }, "StackManager: TTL reaper cycle failed");
      }
    }, intervalMs);
  }

  /** Stop the TTL reaper interval. Called on shutdown. */
  stopTtlReaper(): void {
    if (this.ttlReaperHandle) {
      clearInterval(this.ttlReaperHandle);
      this.ttlReaperHandle = undefined;
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

  /**
   * Optional callback fired when the scan scheduler detects anomalies that
   * passed dedup + prioritization + per-tick cap. The caller is responsible
   * for running investigations (mark/run/complete with sharedDedup + runner).
   * Scheduler does NOT await this callback — investigations run in background.
   */
  onScanAnomalies?: (evt: ScanAnomaliesEvent) => void;
}

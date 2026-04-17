import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "./db.js";
import { StackManager } from "./stack-manager.js";
import type { Config } from "../config/schema.js";
import { DEFAULT_STACK_SLUG } from "../types/stack-types.js";

// Mock ProviderRegistry — MCP connections are not available in tests.
// The mock tracks the seed providers passed to the constructor so that
// listStacks().providerCount (which reads from getAll()) reflects them.
// Exposes a mutable `__viable` flag + `__fireChange()` so individual
// tests can simulate provider additions / connection transitions without
// standing up the real MCP client.
//
// `hasViableMetricsProvider` is defined on the prototype (not the instance)
// so individual tests can override it via `prototype.hasViableMetricsProvider`
// between constructions. Instance-method overrides would only affect the
// current instance, not future ones — many of our tests construct fresh
// StackManager instances which trigger fresh ProviderRegistry instances.
vi.mock("../mcp/provider-registry.js", () => {
  class MockProviderRegistry {
    private seeded: unknown[];
    public __viable = false;
    public __listeners: Array<(event: { kind: string; name: string }) => void> = [];
    initialize = vi.fn().mockResolvedValue(undefined);
    getProviders = vi.fn(() => this.seeded);
    getAll = vi.fn(() => this.seeded.map((config) => ({ config })));
    getByRole = vi.fn().mockReturnValue([]);
    add = vi.fn().mockResolvedValue({});
    remove = vi.fn().mockResolvedValue(undefined);
    onChange = vi.fn((listener: (event: { kind: string; name: string }) => void) => {
      this.__listeners.push(listener);
      return () => { this.__listeners = this.__listeners.filter(l => l !== listener); };
    });
    __fireChange(event: { kind: string; name: string } = { kind: "add", name: "test" }): void {
      for (const l of this.__listeners) l(event);
    }
    constructor(providers: unknown[]) {
      this.seeded = providers ?? [];
    }
  }
  // Prototype method so tests can swap it for all instances at once
  (MockProviderRegistry.prototype as unknown as { hasViableMetricsProvider: () => boolean })
    .hasViableMetricsProvider = function(this: MockProviderRegistry): boolean {
    return this.__viable;
  };
  return { ProviderRegistry: MockProviderRegistry };
});

// Mock ws-handler — clearStackCaches is imported by StackManager
vi.mock("./ws-handler.js", () => ({
  clearStackCaches: vi.fn(),
}));

// Mock ServiceHealthPoller — requires MCP connections for polling
vi.mock("./service-health-poller.js", () => {
  return {
    ServiceHealthPoller: class MockServiceHealthPoller {
      start = vi.fn();
      stop = vi.fn();
      poll = vi.fn().mockResolvedValue(undefined);
      getHealth = vi.fn().mockReturnValue(new Map());
      getSummary = vi.fn().mockReturnValue({ healthy: 0, degraded: 0, down: 0, unknown: 0, total: 0 });
      constructor() {}
    },
  };
});

/**
 * Minimal config for tests — just enough to satisfy StackManager initialization.
 */
function makeConfig(overrides?: Partial<Config>): Config {
  return {
    llm: { model: "gpt-4", maxTokens: 4096, apiKey: "test-key" },
    providers: [
      {
        name: "test-grafana",
        roles: ["metrics"],
        mcpServer: { transport: "http" as const, url: "http://localhost:4000/mcp" },
      },
    ],
    services: [],
    agent: {
      maxIterations: 20,
      conversationMemory: { maxMessages: 50, ttlMinutes: 30 },
      investigationTriggerPhrases: [],
    },
    timeouts: { mcpConnectMs: 30000, llmCallMs: 60000, toolExecutionMs: 30000, agentIterationMs: 90000 },
    retry: { maxAttempts: 3, baseDelayMs: 500 },
    observability: { port: 9090, logLevel: "info" },
    skills: { dir: "./skills", maxPerQuery: 3, maxCharsPerSkill: 2000 },
    discovery: { autoRefresh: false, excludeServices: [], maxIterations: 40, discoveryRecipes: [] },
    memory: { storage: "memory", dbPath: ".dops/memory.db" },
    webhook: { dedupWindowSeconds: 300, maxConcurrent: 3, defaultTemplate: "standard", severityTemplateMap: {} },
    branding: { title: "dops", subtitle: "assistant" },
    ...overrides,
  } as Config;
}

describe("StackManager", () => {
  let db: Database;
  let config: Config;
  let manager: StackManager;

  beforeEach(() => {
    db = new Database(":memory:");
    config = makeConfig();
  });

  afterEach(() => {
    // Clean up memory and pollers to avoid leaking timers
    if (manager) {
      manager.stopAllPollers();
      manager.stopTtlReaper();
      manager.destroyAllMemory();
    }
    db.close();
  });

  describe("initialize", () => {
    it("creates default stack on first run", async () => {
      manager = new StackManager(db, config);
      await manager.initialize();

      const stacks = manager.listStacks();
      expect(stacks).toHaveLength(1);
      expect(stacks[0]!.slug).toBe(DEFAULT_STACK_SLUG);
      expect(stacks[0]!.isDefault).toBe(true);
      expect(stacks[0]!.name).toBe("Default");
    });

    it("finds existing default stack on subsequent runs", async () => {
      // First run — creates default
      manager = new StackManager(db, config);
      await manager.initialize();
      const firstId = manager.getDefaultStackId();
      manager.stopAllPollers();
      manager.destroyAllMemory();

      // Second run — finds existing
      const manager2 = new StackManager(db, config);
      await manager2.initialize();
      const secondId = manager2.getDefaultStackId();
      manager2.stopAllPollers();
      manager2.destroyAllMemory();

      expect(secondId).toBe(firstId);

      // Only one stack exists
      const stacks = manager2.listStacks();
      expect(stacks).toHaveLength(1);
    });

    it("backfills stack_id on existing data", async () => {
      // Insert data without stack_id (simulating pre-migration data)
      // The Database constructor runs migrateStacks which adds the column,
      // but backfill only runs through StackManager.initialize()
      db.createInvestigation("", { id: "inv_1", service: "svc", query: "test", status: "complete" });

      manager = new StackManager(db, config);
      await manager.initialize();

      const defaultId = manager.getDefaultStackId();
      const investigations = db.listInvestigations(defaultId, 10, 0);
      expect(investigations).toHaveLength(1);
      expect(investigations[0]!.id).toBe("inv_1");
    });
  });

  describe("getContext", () => {
    beforeEach(async () => {
      manager = new StackManager(db, config);
      await manager.initialize();
    });

    it("returns context for valid stackId", () => {
      const defaultId = manager.getDefaultStackId();
      const ctx = manager.getContext(defaultId);
      expect(ctx.id).toBe(defaultId);
      expect(ctx.slug).toBe(DEFAULT_STACK_SLUG);
      expect(ctx.name).toBe("Default");
      expect(ctx.providerRegistry).toBeDefined();
      expect(ctx.conversationMemory).toBeDefined();
      expect(ctx.serviceRegistry).toBeDefined();
      expect(ctx.healthPoller).toBeDefined();
    });

    it("throws for invalid stackId", () => {
      expect(() => manager.getContext("nonexistent")).toThrow("Stack not found: nonexistent");
    });
  });

  describe("resolveStackId", () => {
    beforeEach(async () => {
      manager = new StackManager(db, config);
      await manager.initialize();
    });

    it("returns the given stackId if it exists", () => {
      const defaultId = manager.getDefaultStackId();
      expect(manager.resolveStackId(defaultId)).toBe(defaultId);
    });

    it("falls back to default for null", () => {
      const defaultId = manager.getDefaultStackId();
      expect(manager.resolveStackId(null)).toBe(defaultId);
    });

    it("falls back to default for undefined", () => {
      const defaultId = manager.getDefaultStackId();
      expect(manager.resolveStackId(undefined)).toBe(defaultId);
    });

    it("falls back to default for invalid stackId", () => {
      const defaultId = manager.getDefaultStackId();
      expect(manager.resolveStackId("does-not-exist")).toBe(defaultId);
    });
  });

  describe("resolveStackIdWithFallback", () => {
    beforeEach(async () => {
      manager = new StackManager(db, config);
      await manager.initialize();
    });

    it("reports fallback=false when the id is valid", () => {
      const defaultId = manager.getDefaultStackId();
      expect(manager.resolveStackIdWithFallback(defaultId)).toEqual({ id: defaultId, fallback: false });
    });

    it("reports fallback=false when the id is missing (no signal to override)", () => {
      // Null/undefined means "caller didn't specify" — default resolution, not a fallback.
      const defaultId = manager.getDefaultStackId();
      expect(manager.resolveStackIdWithFallback(null)).toEqual({ id: defaultId, fallback: false });
      expect(manager.resolveStackIdWithFallback(undefined)).toEqual({ id: defaultId, fallback: false });
    });

    it("reports fallback=true when the id was present but invalid", () => {
      // This is the case the X-Dops-Stack-Fallback response header exists for:
      // user asked for something specific, we had to pick something else.
      const defaultId = manager.getDefaultStackId();
      expect(manager.resolveStackIdWithFallback("does-not-exist")).toEqual({ id: defaultId, fallback: true });
    });
  });

  describe("createStack", () => {
    beforeEach(async () => {
      manager = new StackManager(db, config);
      await manager.initialize();
    });

    it("creates a new stack with providers", async () => {
      const ctx = await manager.createStack("US East", "us-east", {
        providers: [
          {
            name: "us-east-grafana",
            roles: ["metrics"],
            mcpServer: { transport: "http" as const, url: "http://us-east:4000/mcp" },
          },
        ],
      });

      expect(ctx.id).toBeDefined();
      expect(ctx.slug).toBe("us-east");
      expect(ctx.name).toBe("US East");

      // Listed in stacks
      const stacks = manager.listStacks();
      expect(stacks).toHaveLength(2);
      const usEast = stacks.find((s) => s.slug === "us-east");
      expect(usEast).toBeDefined();
      expect(usEast!.isDefault).toBe(false);
      expect(usEast!.providerCount).toBe(1);
    });

    it("starts the health poller for stacks created after boot when viable", async () => {
      // Regression: startAllPollers() only runs once at server boot, so stacks
      // created via the GUI/API later would never poll without createStack()
      // calling start() itself. Services in those stacks appeared permanently
      // "unknown" even with providers configured.
      //
      // The gate added in #8 only starts the poller if there's a viable
      // metrics provider. We pre-flip the mock's `__viable` flag via a
      // one-shot spy on hasViableMetricsProvider so the gate returns true
      // at createStack time.
      const { ProviderRegistry } = await import("../mcp/provider-registry.js");
      const origHas = ProviderRegistry.prototype.hasViableMetricsProvider;
      ProviderRegistry.prototype.hasViableMetricsProvider = vi.fn(() => true);
      try {
        const ctx = await manager.createStack("Boot Test", "boot-test", { providers: [] });
        expect(ctx.healthPoller.start).toHaveBeenCalled();
      } finally {
        ProviderRegistry.prototype.hasViableMetricsProvider = origHas;
      }
    });

    it("skips the health poller for stacks with no viable metrics provider (issue #8)", async () => {
      // Legacy stacks with 3 registered providers but runtime toolCount:0 used
      // to spam "metric query tool not found, skipping poll" every 10s. The
      // gate silences them by skipping the initial start() call — they'll
      // auto-start via the registry change event when a working provider is
      // added or tested.
      const ctx = await manager.createStack("Empty Stack", "empty-stack", { providers: [] });
      expect(ctx.healthPoller.start).not.toHaveBeenCalled();
    });

    it("starts a previously-skipped poller when a provider change event fires", async () => {
      // Adding a viable metrics provider to a dormant stack (or having one
      // become healthy via test()) should flip the gate and kick off polling
      // without requiring a server restart.
      const ctx = await manager.createStack("Will Become Viable", "viable-later", { providers: [] });
      expect(ctx.healthPoller.start).not.toHaveBeenCalled();

      // Simulate: provider gets added + becomes viable
      const mockRegistry = ctx.providerRegistry as unknown as {
        __viable: boolean;
        __fireChange: (e?: { kind: string; name: string }) => void;
      };
      mockRegistry.__viable = true;
      mockRegistry.__fireChange({ kind: "add", name: "new-provider" });

      expect(ctx.healthPoller.start).toHaveBeenCalled();
    });

    it("rejects duplicate slugs", async () => {
      await manager.createStack("Stack A", "my-slug", { providers: [] });
      await expect(
        manager.createStack("Stack B", "my-slug", { providers: [] }),
      ).rejects.toThrow('Stack with slug "my-slug" already exists');
    });
  });

  describe("deleteStack", () => {
    beforeEach(async () => {
      manager = new StackManager(db, config);
      await manager.initialize();
    });

    it("removes stack and all data", async () => {
      const ctx = await manager.createStack("Temp", "temp-stack", { providers: [] });
      const stackId = ctx.id;

      // Add some data to the stack
      db.createInvestigation(stackId, { id: "inv_temp", service: "svc", query: "test", status: "complete" });
      db.createMessage(stackId, { id: "msg_temp", role: "user", content: "hello" });

      await manager.deleteStack(stackId);

      // Stack no longer in manager
      expect(() => manager.getContext(stackId)).toThrow("Stack not found");

      // Stack data deleted from DB
      const investigations = db.listInvestigations(stackId, 10, 0);
      expect(investigations).toHaveLength(0);

      // Only default stack remains
      const stacks = manager.listStacks();
      expect(stacks).toHaveLength(1);
      expect(stacks[0]!.isDefault).toBe(true);
    });

    it("rejects deleting default stack", async () => {
      const defaultId = manager.getDefaultStackId();
      await expect(manager.deleteStack(defaultId)).rejects.toThrow("Cannot delete the default stack");
    });
  });

  describe("listStacks", () => {
    beforeEach(async () => {
      manager = new StackManager(db, config);
      await manager.initialize();
    });

    it("returns summaries for all stacks", async () => {
      await manager.createStack("US East", "us-east", {
        providers: [
          {
            name: "grafana-east",
            roles: ["metrics"],
            mcpServer: { transport: "http" as const, url: "http://east:4000/mcp" },
          },
          {
            name: "grafana-east-logs",
            roles: ["logs"],
            mcpServer: { transport: "http" as const, url: "http://east:4001/mcp" },
          },
        ],
      });

      const stacks = manager.listStacks();
      expect(stacks).toHaveLength(2);

      const defaultStack = stacks.find((s) => s.isDefault)!;
      expect(defaultStack.slug).toBe(DEFAULT_STACK_SLUG);
      expect(defaultStack.providerCount).toBe(1); // from config

      const usEast = stacks.find((s) => s.slug === "us-east")!;
      expect(usEast.isDefault).toBe(false);
      expect(usEast.providerCount).toBe(2);
      expect(usEast.healthSummary).toBeDefined();
      expect(usEast.createdAt).toBeDefined();
    });
  });

  describe("getDefaultContext", () => {
    it("returns the default stack context after initialization", async () => {
      manager = new StackManager(db, config);
      await manager.initialize();

      const ctx = manager.getDefaultContext();
      expect(ctx.slug).toBe(DEFAULT_STACK_SLUG);
      expect(ctx.id).toBe(manager.getDefaultStackId());
    });

    it("throws if not initialized", () => {
      manager = new StackManager(db, config);
      expect(() => manager.getDefaultContext()).toThrow("StackManager not initialized");
    });
  });

  describe("pollers", () => {
    it("startAllPollers calls start on viable stacks only", async () => {
      // With the init-time gate, startAllPollers must skip stacks that have
      // no viable metrics provider. Patch the prototype so the mock reports
      // viable for the duration of this test.
      const { ProviderRegistry } = await import("../mcp/provider-registry.js");
      const origHas = ProviderRegistry.prototype.hasViableMetricsProvider;
      ProviderRegistry.prototype.hasViableMetricsProvider = vi.fn(() => true);
      try {
        manager = new StackManager(db, config);
        await manager.initialize();

        // Use fake timers to avoid actual setTimeout delays
        vi.useFakeTimers();
        manager.startAllPollers();

        // Advance past the stagger window (30s)
        vi.advanceTimersByTime(31_000);

        const ctx = manager.getDefaultContext();
        expect(ctx.healthPoller.start).toHaveBeenCalled();

        vi.useRealTimers();
      } finally {
        ProviderRegistry.prototype.hasViableMetricsProvider = origHas;
      }
    });

    it("startAllPollers skips non-viable stacks, starts them later on provider change", async () => {
      manager = new StackManager(db, config);
      await manager.initialize();

      vi.useFakeTimers();
      manager.startAllPollers();
      vi.advanceTimersByTime(31_000);

      const ctx = manager.getDefaultContext();
      expect(ctx.healthPoller.start).not.toHaveBeenCalled();

      vi.useRealTimers();

      // Now simulate the provider becoming viable
      const mockRegistry = ctx.providerRegistry as unknown as {
        __viable: boolean;
        __fireChange: (e?: { kind: string; name: string }) => void;
      };
      mockRegistry.__viable = true;
      mockRegistry.__fireChange({ kind: "test", name: "x" });
      expect(ctx.healthPoller.start).toHaveBeenCalled();
    });

    it("stopAllPollers calls stop on each health poller", async () => {
      manager = new StackManager(db, config);
      await manager.initialize();

      manager.stopAllPollers();

      const ctx = manager.getDefaultContext();
      expect(ctx.healthPoller.stop).toHaveBeenCalled();
    });
  });

  // ── TTL / last-active tracking (B-2) ────────────────────────────────────

  describe("TTL + activity tracking", () => {
    beforeEach(async () => {
      manager = new StackManager(db, config);
      await manager.initialize();
    });

    it("createStack sets last_active_at to now", async () => {
      const ctx = await manager.createStack("Fresh", "fresh-stack", { providers: [] });
      const row = db.getStack(ctx.id);
      expect(row).toBeDefined();
      expect(row!.last_active_at).toBeDefined();
      // SQLite returns "YYYY-MM-DD HH:MM:SS" (UTC, no T). Parse + compare to now.
      const activeMs = new Date(row!.last_active_at + "Z").getTime();
      expect(Math.abs(Date.now() - activeMs)).toBeLessThan(5000);
    });

    it("bumpActivity updates last_active_at and clears inactive marker", async () => {
      const ctx = await manager.createStack("Busy", "busy-stack", { providers: [] });
      // Simulate an inactive marker already present (as if the reaper hit)
      const nowBefore = new Date().toISOString();
      // Force last_active_at backwards by direct DB write so bump is visible
      (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
        .prepare("UPDATE stacks SET last_active_at = ?, inactive_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", "2020-02-01T00:00:00.000Z", ctx.id);

      manager.bumpActivity(ctx.id);

      const row = db.getStack(ctx.id);
      expect(row!.last_active_at! > nowBefore.slice(0, 10)).toBe(true);
      expect(row!.inactive_at).toBeNull();
    });

    it("runTtlReaper marks idle stacks inactive after 30 days", async () => {
      const ctx = await manager.createStack("Idle", "idle-stack", { providers: [] });

      // Simulate a run 31 days from now — runTtlReaper accepts nowIso.
      const future = new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString();
      const result = manager.runTtlReaper({ nowIso: future });
      expect(result.markedInactive).toBe(1);
      expect(result.softDeleted).toBe(0);

      const row = db.getStack(ctx.id);
      expect(row!.inactive_at).not.toBeNull();
      expect(row!.deleted_at).toBeNull();

      // Still listed (active + inactive both visible)
      const stacks = manager.listStacks();
      const summary = stacks.find(s => s.id === ctx.id);
      expect(summary).toBeDefined();
      expect(summary!.status).toBe("inactive");
    });

    it("runTtlReaper soft-deletes stacks idle >60 days and drops them from listings", async () => {
      const ctx = await manager.createStack("Ancient", "ancient-stack", { providers: [] });

      const future = new Date(Date.now() + 61 * 24 * 3600 * 1000).toISOString();
      const result = manager.runTtlReaper({ nowIso: future });
      expect(result.softDeleted).toBe(1);

      // Not in default listing
      expect(manager.listStacks().find(s => s.id === ctx.id)).toBeUndefined();
      // Still in DB (audit trail)
      expect(db.listStacksIncludingDeleted().find(s => s.id === ctx.id)).toBeDefined();
      // In-memory context torn down
      expect(() => manager.getContext(ctx.id)).toThrow("Stack not found");
    });

    it("runTtlReaper never touches the default stack even if idle", async () => {
      const defaultId = manager.getDefaultStackId();
      // Force default's last_active_at way into the past
      (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
        .prepare("UPDATE stacks SET last_active_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", defaultId);

      const result = manager.runTtlReaper();
      expect(result.markedInactive).toBe(0);
      expect(result.softDeleted).toBe(0);
      expect(db.getStack(defaultId)).toBeDefined();
    });

    it("DELETE on a stack still works and is distinct from TTL soft-delete", async () => {
      // Regression guard (IRON RULE): the existing explicit delete path
      // must keep working — it hard-deletes immediately, unlike the TTL
      // reaper's soft-delete which keeps the row for audit.
      const ctx = await manager.createStack("To Remove", "to-remove", { providers: [] });
      await manager.deleteStack(ctx.id);

      // Hard-gone from both the live and the including-deleted views.
      expect(manager.listStacks().find(s => s.id === ctx.id)).toBeUndefined();
      expect(db.listStacksIncludingDeleted().find(s => s.id === ctx.id)).toBeUndefined();
    });
  });
});

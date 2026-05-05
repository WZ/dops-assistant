import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "./db.js";
import { StackManager } from "./stack-manager.js";
import type { Config } from "../config/schema.js";
import { DEFAULT_STACK_SLUG } from "../types/stack-types.js";
import * as slackNotifier from "./slack-notifier.js";
import * as emailNotifier from "./email-notifier.js";
import { eventLog } from "./event-log.js";
import type { ScanRunCompletedSummary } from "./scan-run-store.js";
import type { EmailNotifierDeps } from "./email-notifier.js";
import { runDiscovery } from "../workflows/discovery.js";

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
    getAll = vi.fn(() => this.seeded.map((config) => ({
      config,
      prometheusDatasourceUid: (config as { prometheusDatasourceUid?: string; roles?: string[] }).prometheusDatasourceUid
        ?? ((config as { roles?: string[] }).roles?.includes("metrics") ? "prom-ds" : undefined),
    })));
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

vi.mock("../workflows/discovery.js", () => ({
  runDiscovery: vi.fn(),
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
    scan: {
      enabled: false,
      cron: "0 */4 * * *",
      timezone: "UTC",
      maxInvestigationsPerTick: 5,
      investigationTemplate: "standard",
      runOnEnable: false,
      dedupWindowMinutes: 30,
      probe: {
        concurrency: 8,
        queryTimeoutMs: 3000,
        metrics: [],
        logs: { enabled: false, window: "15m", errorRateThreshold: 10, consecutiveTicks: 2 },
      },
    },
    branding: { title: "dops", subtitle: "assistant" },
    k8sEvents: {
      enabled: false,
      intervalSeconds: 300,
      badReasons: ["OOMKilled"],
      ignoreReasons: ["Completed"],
      maxEventsPerTick: 50,
      queryTimeoutMs: 15_000,
    },
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
    vi.mocked(runDiscovery).mockReset();
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

  describe("periodic discovery notifications", () => {
    it("sends email through periodic-discovery recipients before marking the channel successful", async () => {
      config = makeConfig({
        discovery: {
          autoRefresh: false,
          excludeServices: [],
          maxIterations: 40,
          discoveryRecipes: [],
          periodic: {
            enabled: true,
            cron: "0 0 * * *",
            timezone: "UTC",
            consensusRuns: 1,
            consensusRunsForRemovals: 1,
          },
        },
      });
      vi.mocked(runDiscovery).mockResolvedValue({
        services: [{
          name: "svc-a",
          metrics: [],
          logLabels: {},
          probeRules: [],
          confidence: "verified",
        }],
        globalProbeRules: [],
      } as any);

      manager = new StackManager(db, config);
      await manager.initialize();
      manager.setLlmModel({} as any);

      const transport = { sendMail: vi.fn().mockResolvedValue({}) };
      const emailDeps: EmailNotifierDeps = {
        isGloballyEnabled: () => true,
        listEnabledRecipients: () => [{
          id: 1,
          address: "ops@example.test",
          minSeverity: "low",
          allowedSources: ["periodic-discovery"],
          enabled: true,
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        }],
        transport: transport as any,
        config: {
          from: "Ops <ops@example.test>",
          appBaseUrl: "https://app.example.test",
          retry: { attempts: 1, backoffMs: [] },
        },
      };
      manager.setEmailNotifierDepsBuilder(() => emailDeps);

      await manager.getDefaultContext().periodicDiscoveryScheduler.tickOnce();

      expect(transport.sendMail).toHaveBeenCalledTimes(1);
      expect(transport.sendMail.mock.calls[0]![0]).toMatchObject({
        from: "Ops <ops@example.test>",
        to: "ops@example.test",
      });
      const row = manager.getDefaultContext().pendingDiscoveryStore.findByStackKindName(
        manager.getDefaultStackId(),
        "addition",
        "svc-a",
      )!;
      expect(manager.getDefaultContext().pendingDiscoveryStore.hasSuccessfulNotification(row.id, "email")).toBe(true);
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

describe("stale-scan-run sweep", () => {
  it("flips status='running' rows to 'failed' with error_message + finished_at set", () => {
    const db = new Database(":memory:");
    const now = Date.now();
    db.insertScanRun({ id: "r1", stackId: "s1", trigger: "cron", startedAt: now - 10_000 });
    db.insertScanRun({ id: "r2", stackId: "s1", trigger: "manual", startedAt: now - 5_000 });
    db.updateScanRun("r2", { status: "complete", finishedAt: now - 4_000 });

    db.sweepStaleScanRuns();

    const r1 = db.getScanRun("s1", "r1")!;
    const r2 = db.getScanRun("s1", "r2")!;
    expect(r1.status).toBe("failed");
    expect(r1.errorMessage).toContain("Server restarted");
    expect(r1.finishedAt).toBeGreaterThan(0);
    expect(r2.status).toBe("complete");
    db.close();
  });
});

/**
 * Access helper: handleScanRunComplete is private. We call it via a typed cast
 * so the test stays agnostic to whether implementation uses a callback or
 * direct method invocation from the scheduler.
 */
function callHandleScanRunComplete(
  sm: StackManager,
  summary: ScanRunCompletedSummary,
): void {
  (sm as unknown as { handleScanRunComplete: (s: ScanRunCompletedSummary) => void })
    .handleScanRunComplete(summary);
}

describe("StackManager — handleScanRunComplete", () => {
  let db: Database;
  let config: Config;
  let manager: StackManager;
  let slackSpy: ReturnType<typeof vi.spyOn>;
  let emailSpy: ReturnType<typeof vi.spyOn>;

  const baseSummary: ScanRunCompletedSummary = {
    runId: "r1",
    stackId: "s1",
    trigger: "cron",
    startedAt: Date.now(),
    durationMs: 500,
    servicesProbed: 100,
    hitsDispatched: 0,
    dispatchedServices: [],
  };

  beforeEach(async () => {
    db = new Database(":memory:");
    config = makeConfig();
    manager = new StackManager(db, config);
    await manager.initialize();
    slackSpy = vi.spyOn(slackNotifier, "notifySlackOnScanComplete").mockResolvedValue(undefined);
    emailSpy = vi.spyOn(emailNotifier, "notifyEmailScanRun").mockResolvedValue(undefined);
    eventLog.reset();
  });

  afterEach(() => {
    slackSpy.mockRestore();
    emailSpy.mockRestore();
    if (manager) {
      manager.stopAllPollers();
      manager.stopTtlReaper();
      manager.destroyAllMemory();
    }
    db.close();
    eventLog.reset();
  });

  it("appends a scan_run_complete eventLog entry with 'info' severity when hitsDispatched=0", () => {
    callHandleScanRunComplete(manager, baseSummary);
    const { events } = eventLog.recent(10, "s1");
    const entry = events.find(e => e.kind === "scan_run_complete");
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe("info");
    expect(entry!.href).toBe("/scan/runs/r1");
    expect(entry!.stackId).toBe("s1");
  });

  it("uses 'warn' severity when hitsDispatched>0", () => {
    callHandleScanRunComplete(manager, { ...baseSummary, hitsDispatched: 3, dispatchedServices: ["a", "b", "c"] });
    const { events } = eventLog.recent(10, "s1");
    const entry = events.find(e => e.kind === "scan_run_complete");
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe("warn");
    expect(entry!.summary).toContain("3");
  });

  it("respects notifications.slack.onScanComplete='off' — does NOT call notifySlackOnScanComplete", () => {
    db.setSetting("notifications.slack.webhookUrl", "https://hooks.slack.com/services/T/B/xxx");
    db.setSetting("notifications.slack.onScanComplete", "off");
    callHandleScanRunComplete(manager, { ...baseSummary, hitsDispatched: 5 });
    expect(slackSpy).not.toHaveBeenCalled();
  });

  it("respects 'hits-only' (default) when hits=0: does not call slack", () => {
    db.setSetting("notifications.slack.webhookUrl", "https://hooks.slack.com/services/T/B/xxx");
    // default mode is hits-only — don't set the setting explicitly
    callHandleScanRunComplete(manager, baseSummary); // hitsDispatched: 0
    expect(slackSpy).not.toHaveBeenCalled();
  });

  it("fires slack when mode='always' even with hits=0", () => {
    db.setSetting("notifications.slack.webhookUrl", "https://hooks.slack.com/services/T/B/xxx");
    db.setSetting("notifications.slack.onScanComplete", "always");
    callHandleScanRunComplete(manager, baseSummary); // hitsDispatched: 0
    expect(slackSpy).toHaveBeenCalledTimes(1);
    expect(slackSpy.mock.calls[0]![0]).toMatchObject({ slackWebhookUrl: "https://hooks.slack.com/services/T/B/xxx" });
  });

  it("fires slack when mode='hits-only' and hits>0", () => {
    db.setSetting("notifications.slack.webhookUrl", "https://hooks.slack.com/services/T/B/xxx");
    db.setSetting("notifications.slack.onScanComplete", "hits-only");
    callHandleScanRunComplete(manager, { ...baseSummary, hitsDispatched: 2 });
    expect(slackSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fire slack when notifications.slack.enabled='false' even if url set + mode=always", () => {
    db.setSetting("notifications.slack.webhookUrl", "https://hooks.slack.com/services/T/B/xxx");
    db.setSetting("notifications.slack.enabled", "false");
    db.setSetting("notifications.slack.onScanComplete", "always");
    callHandleScanRunComplete(manager, baseSummary);
    expect(slackSpy).not.toHaveBeenCalled();
  });

  it("calls notifyEmailScanRun whenever the email notifier deps builder yields deps", () => {
    const fakeDeps = {
      isGloballyEnabled: () => true,
      listEnabledRecipients: () => [],
      transport: { sendMail: vi.fn() } as unknown as EmailNotifierDeps["transport"],
      config: { from: "x@x", appBaseUrl: "https://dops.example", retry: { attempts: 1, backoffMs: [] } },
    } satisfies EmailNotifierDeps;
    manager.setEmailNotifierDepsBuilder(() => fakeDeps);
    callHandleScanRunComplete(manager, baseSummary);
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]![1]).toMatchObject({ runId: "r1" });
  });

  it("does not call notifyEmailScanRun when the email notifier deps builder is unset", () => {
    callHandleScanRunComplete(manager, baseSummary);
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("does not call notifyEmailScanRun when the builder returns null for the stack", () => {
    manager.setEmailNotifierDepsBuilder(() => null);
    callHandleScanRunComplete(manager, baseSummary);
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("no-op on slack if webhookUrl is unset (no db setting and no config fallback)", () => {
    // default config has no webhook.slackWebhookUrl, no db setting
    db.setSetting("notifications.slack.onScanComplete", "always");
    callHandleScanRunComplete(manager, baseSummary);
    expect(slackSpy).not.toHaveBeenCalled();
  });

  it("event-log entry fires unconditionally even when all notifications are off", () => {
    db.setSetting("notifications.slack.onScanComplete", "off");
    callHandleScanRunComplete(manager, baseSummary);
    const { events } = eventLog.recent(10, "s1");
    expect(events.some(e => e.kind === "scan_run_complete")).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "./db.js";
import { StackManager } from "./stack-manager.js";
import type { Config } from "../config/schema.js";
import { DEFAULT_STACK_SLUG } from "../types/stack-types.js";

// Mock ProviderRegistry — MCP connections are not available in tests
vi.mock("../mcp/provider-registry.js", () => {
  return {
    ProviderRegistry: class MockProviderRegistry {
      initialize = vi.fn().mockResolvedValue(undefined);
      getProviders = vi.fn().mockReturnValue([]);
      getAll = vi.fn().mockReturnValue([]);
      getByRole = vi.fn().mockReturnValue([]);
      add = vi.fn().mockResolvedValue({});
      remove = vi.fn().mockResolvedValue(undefined);
      constructor() {}
    },
  };
});

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
    it("startAllPollers calls start on each health poller", async () => {
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
    });

    it("stopAllPollers calls stop on each health poller", async () => {
      manager = new StackManager(db, config);
      await manager.initialize();

      manager.stopAllPollers();

      const ctx = manager.getDefaultContext();
      expect(ctx.healthPoller.stop).toHaveBeenCalled();
    });
  });
});

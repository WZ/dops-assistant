import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";
import { getEffectiveReasoningEffort, getStackLlmSettingsView } from "./llm-settings.js";
import type { Config, ReasoningEffort } from "../config/schema.js";

function makeConfig(reasoning?: Partial<Record<"default" | "chat" | "investigation" | "discovery", ReasoningEffort>>): Config {
  return {
    llm: {
      apiKey: "k",
      model: "gpt-4",
      retry: { maxAttempts: 8, initialDelayMs: 2000, maxDelayMs: 60_000, jitterPercent: 0.3 },
      ...(reasoning ? { reasoningEffort: reasoning } : {}),
    },
    providers: [],
    services: [],
    serviceAliases: {},
    agent: { maxIterations: 20, investigationTriggerPhrases: [], conversationMemory: { maxMessages: 50, ttlMinutes: 30 } },
    timeouts: { mcpConnectMs: 30000, llmCallMs: 60000, toolExecutionMs: 30000, agentIterationMs: 90000 },
    retry: { maxAttempts: 3, baseDelayMs: 500 },
    observability: { port: 9090, logLevel: "info" },
    skills: { dir: "./skills", maxPerQuery: 3, maxCharsPerSkill: 2000 },
    discovery: { autoRefresh: false, excludeServices: [], maxIterations: 40 },
    memory: { storage: "memory", dbPath: ".dops/memory.db" },
    webhook: { dedupWindowSeconds: 300, maxConcurrent: 3, defaultTemplate: "standard", severityTemplateMap: {} },
    branding: { title: "dops", subtitle: "assistant" },
  } as Config;
}

describe("getEffectiveReasoningEffort — precedence", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("returns undefined when nothing is set anywhere", () => {
    expect(getEffectiveReasoningEffort(db, makeConfig(), "stack-1", "chat")).toBeUndefined();
  });

  it("falls back to config.default when no bucket-specific config or stack value", () => {
    expect(getEffectiveReasoningEffort(db, makeConfig({ default: "medium" }), "stack-1", "chat")).toBe("medium");
    expect(getEffectiveReasoningEffort(db, makeConfig({ default: "medium" }), "stack-1", "investigation")).toBe("medium");
  });

  it("config bucket beats config.default", () => {
    const config = makeConfig({ default: "medium", chat: "low" });
    expect(getEffectiveReasoningEffort(db, config, "stack-1", "chat")).toBe("low");
    expect(getEffectiveReasoningEffort(db, config, "stack-1", "investigation")).toBe("medium");
  });

  it("stack override beats config bucket and config.default", () => {
    db.setStackReasoningEffort("stack-1", { chat: "high" });
    const config = makeConfig({ default: "medium", chat: "low" });
    expect(getEffectiveReasoningEffort(db, config, "stack-1", "chat")).toBe("high");
    expect(getEffectiveReasoningEffort(db, config, "stack-1", "investigation")).toBe("medium");
  });

  it("stack override is per-stack (does not bleed across stacks)", () => {
    db.setStackReasoningEffort("stack-a", { chat: "high" });
    db.setStackReasoningEffort("stack-b", { chat: "low" });
    const config = makeConfig({ default: "medium" });
    expect(getEffectiveReasoningEffort(db, config, "stack-a", "chat")).toBe("high");
    expect(getEffectiveReasoningEffort(db, config, "stack-b", "chat")).toBe("low");
  });
});

describe("Database — setStackReasoningEffort/getStackReasoningEffort", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("returns empty when nothing is set", () => {
    expect(db.getStackReasoningEffort("stack-1")).toEqual({});
  });

  it("writes and reads back per-bucket overrides", () => {
    db.setStackReasoningEffort("stack-1", { chat: "high", investigation: "medium" });
    expect(db.getStackReasoningEffort("stack-1")).toEqual({ chat: "high", investigation: "medium" });
  });

  it("merges subsequent writes (does not overwrite untouched buckets)", () => {
    db.setStackReasoningEffort("stack-1", { chat: "high" });
    db.setStackReasoningEffort("stack-1", { investigation: "low" });
    expect(db.getStackReasoningEffort("stack-1")).toEqual({ chat: "high", investigation: "low" });
  });

  it("null clears a bucket", () => {
    db.setStackReasoningEffort("stack-1", { chat: "high", investigation: "medium" });
    db.setStackReasoningEffort("stack-1", { chat: null });
    expect(db.getStackReasoningEffort("stack-1")).toEqual({ investigation: "medium" });
  });

  it("clearing the last bucket deletes the row", () => {
    db.setStackReasoningEffort("stack-1", { chat: "high" });
    db.setStackReasoningEffort("stack-1", { chat: null });
    expect(db.getStackReasoningEffort("stack-1")).toEqual({});
  });

  it("ignores unknown buckets and invalid efforts", () => {
    db.setStackReasoningEffort("stack-1", {
      chat: "high",
      // @ts-expect-error testing invalid input
      bogus: "high",
      // @ts-expect-error testing invalid input
      investigation: "extreme",
    });
    expect(db.getStackReasoningEffort("stack-1")).toEqual({ chat: "high" });
  });

  it("malformed JSON in DB returns empty object", () => {
    db.setSetting("llm.reasoningEffort.stack-1", "{not json");
    expect(db.getStackReasoningEffort("stack-1")).toEqual({});
  });
});

describe("getStackLlmSettingsView", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("exposes config defaults, stack overrides, and effective values with sources", () => {
    db.setStackReasoningEffort("stack-1", { chat: "high" });
    const view = getStackLlmSettingsView(
      db,
      makeConfig({ default: "medium", investigation: "low" }),
      "stack-1",
    );
    expect(view.stack).toEqual({ chat: "high" });
    expect(view.config).toEqual({ default: "medium", investigation: "low" });
    expect(view.effective).toEqual({
      chat: { effort: "high", source: "stack" },
      investigation: { effort: "low", source: "config" },
      discovery: { effort: "medium", source: "default" },
    });
  });

  it("reports null source per bucket when nothing is set anywhere", () => {
    const view = getStackLlmSettingsView(db, makeConfig(), "stack-1");
    expect(view.effective.chat).toEqual({ effort: undefined, source: null });
    expect(view.effective.investigation).toEqual({ effort: undefined, source: null });
    expect(view.effective.discovery).toEqual({ effort: undefined, source: null });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";
import {
  getEffectiveK8sEventsConfig,
  getK8sEventsSettingsView,
  K8S_EVENTS_SETTING_KEYS,
} from "./k8s-events-settings.js";
import type { Config, K8sEventsConfig } from "../config/schema.js";

function makeK8sEventsConfig(overrides: Partial<K8sEventsConfig> = {}): K8sEventsConfig {
  return {
    enabled: false,
    intervalSeconds: 300,
    badReasons: ["OOMKilled"],
    ignoreReasons: ["Completed"],
    maxEventsPerTick: 50,
    queryTimeoutMs: 15_000,
    ...overrides,
  };
}

function makeConfig(k8sOverrides: Partial<K8sEventsConfig> = {}): Config {
  return {
    llm: { apiKey: "k", model: "gpt-4", maxTokens: 1000 },
    providers: [],
    services: [],
    serviceAliases: {},
    agent: { maxIterations: 20, investigationTriggerPhrases: [], conversationMemory: { maxMessages: 50, ttlMinutes: 30 } },
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
      runOnEnable: true,
      dedupWindowMinutes: 30,
      probe: {
        concurrency: 8,
        queryTimeoutMs: 3000,
        metrics: [],
        logs: { enabled: true, window: "15m", errorRateThreshold: 10, consecutiveTicks: 2 },
      },
    },
    k8sEvents: makeK8sEventsConfig(k8sOverrides),
    branding: { title: "dops", subtitle: "assistant" },
  } as Config;
}

describe("getEffectiveK8sEventsConfig", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("returns base config verbatim when no DB override exists", () => {
    const config = makeConfig({ enabled: false, intervalSeconds: 600, maxEventsPerTick: 25 });
    const eff = getEffectiveK8sEventsConfig(db, config);
    expect(eff.enabled).toBe(false);
    expect(eff.intervalSeconds).toBe(600);
    expect(eff.maxEventsPerTick).toBe(25);
  });

  it("applies db.settings enabled=true on top of config.enabled=false", () => {
    db.setSetting(K8S_EVENTS_SETTING_KEYS.enabled, "true");
    const config = makeConfig({ enabled: false });
    expect(getEffectiveK8sEventsConfig(db, config).enabled).toBe(true);
  });

  it("applies db.settings enabled=false on top of config.enabled=true", () => {
    db.setSetting(K8S_EVENTS_SETTING_KEYS.enabled, "false");
    const config = makeConfig({ enabled: true });
    expect(getEffectiveK8sEventsConfig(db, config).enabled).toBe(false);
  });

  it("preserves non-GUI-editable fields from config.yaml even when override is set", () => {
    db.setSetting(K8S_EVENTS_SETTING_KEYS.enabled, "true");
    const config = makeConfig({
      enabled: false,
      badReasons: ["X", "Y"],
      ignoreReasons: ["Z"],
      intervalSeconds: 900,
      maxEventsPerTick: 33,
      queryTimeoutMs: 9_000,
    });
    const eff = getEffectiveK8sEventsConfig(db, config);
    expect(eff.enabled).toBe(true);            // override
    expect(eff.badReasons).toEqual(["X", "Y"]); // base
    expect(eff.ignoreReasons).toEqual(["Z"]);   // base
    expect(eff.intervalSeconds).toBe(900);      // base
    expect(eff.maxEventsPerTick).toBe(33);      // base
    expect(eff.queryTimeoutMs).toBe(9_000);     // base
  });
});

describe("getK8sEventsSettingsView", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("source is 'config' when no DB override is set", () => {
    const view = getK8sEventsSettingsView(db, makeConfig({ enabled: false }));
    expect(view.enabled).toBe(false);
    expect(view.source.enabled).toBe("config");
  });

  it("source is 'gui' when DB override is set, even if value matches config", () => {
    db.setSetting(K8S_EVENTS_SETTING_KEYS.enabled, "false");
    const view = getK8sEventsSettingsView(db, makeConfig({ enabled: false }));
    expect(view.enabled).toBe(false);
    expect(view.source.enabled).toBe("gui");
  });

  it("source switches to 'gui' after a write that flips the value", () => {
    db.setSetting(K8S_EVENTS_SETTING_KEYS.enabled, "true");
    const view = getK8sEventsSettingsView(db, makeConfig({ enabled: false }));
    expect(view.enabled).toBe(true);
    expect(view.source.enabled).toBe("gui");
  });
});

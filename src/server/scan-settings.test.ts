import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";
import { getEffectiveScanConfig, getScanSettingsView, SCAN_SETTING_KEYS } from "./scan-settings.js";
import type { Config, ScanConfig } from "../config/schema.js";

function makeScanConfig(overrides: Partial<ScanConfig> = {}): ScanConfig {
  return {
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
    ...overrides,
  };
}

function makeConfig(scanOverrides: Partial<ScanConfig> = {}): Config {
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
    scan: makeScanConfig(scanOverrides),
    branding: { title: "dops", subtitle: "assistant" },
  } as Config;
}

describe("getEffectiveScanConfig", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("returns the base config verbatim when no DB overrides exist", () => {
    const config = makeConfig({ enabled: false, cron: "0 0 * * *", timezone: "UTC" });
    const eff = getEffectiveScanConfig(db, config);
    expect(eff.enabled).toBe(false);
    expect(eff.cron).toBe("0 0 * * *");
    expect(eff.timezone).toBe("UTC");
  });

  it("applies db.settings enabled=true on top of config.enabled=false", () => {
    db.setSetting(SCAN_SETTING_KEYS.enabled, "true");
    const config = makeConfig({ enabled: false });
    expect(getEffectiveScanConfig(db, config).enabled).toBe(true);
  });

  it("applies db.settings enabled=false on top of config.enabled=true", () => {
    db.setSetting(SCAN_SETTING_KEYS.enabled, "false");
    const config = makeConfig({ enabled: true });
    expect(getEffectiveScanConfig(db, config).enabled).toBe(false);
  });

  it("applies db.settings cron override", () => {
    db.setSetting(SCAN_SETTING_KEYS.cron, "*/5 * * * *");
    const eff = getEffectiveScanConfig(db, makeConfig({ cron: "0 */4 * * *" }));
    expect(eff.cron).toBe("*/5 * * * *");
  });

  it("applies db.settings timezone override", () => {
    db.setSetting(SCAN_SETTING_KEYS.timezone, "America/New_York");
    const eff = getEffectiveScanConfig(db, makeConfig({ timezone: "UTC" }));
    expect(eff.timezone).toBe("America/New_York");
  });

  it("preserves non-overridable fields (probe, maxInvestigationsPerTick, etc.)", () => {
    db.setSetting(SCAN_SETTING_KEYS.enabled, "true");
    const config = makeConfig({ maxInvestigationsPerTick: 7 });
    const eff = getEffectiveScanConfig(db, config);
    expect(eff.maxInvestigationsPerTick).toBe(7);
    expect(eff.probe).toBe(config.scan.probe); // same reference — not cloned unnecessarily
  });

  it('parses db "true"/"false" strings correctly (not JSON.parse)', () => {
    db.setSetting(SCAN_SETTING_KEYS.enabled, "True"); // intentionally wrong case
    // Strict equality — "True" does not equal "true" string, so falls back to config
    expect(getEffectiveScanConfig(db, makeConfig({ enabled: false })).enabled).toBe(false);
  });
});

describe("getScanSettingsView", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("reports source: config for every field when no overrides exist", () => {
    const view = getScanSettingsView(db, makeConfig());
    expect(view.source).toEqual({ enabled: "config", cron: "config", timezone: "config" });
  });

  it("reports source: gui for fields that have overrides", () => {
    db.setSetting(SCAN_SETTING_KEYS.enabled, "true");
    db.setSetting(SCAN_SETTING_KEYS.cron, "*/15 * * * *");
    // timezone stays config
    const view = getScanSettingsView(db, makeConfig());
    expect(view.source.enabled).toBe("gui");
    expect(view.source.cron).toBe("gui");
    expect(view.source.timezone).toBe("config");
    expect(view.enabled).toBe(true);
    expect(view.cron).toBe("*/15 * * * *");
  });

  it('distinguishes empty-string override from no override (setSetting("") is still an override)', () => {
    // An empty-string stored value should NOT be confused with "no override set"
    // (db.getSetting returns undefined for unset keys, empty string for empty).
    db.setSetting(SCAN_SETTING_KEYS.timezone, "");
    const view = getScanSettingsView(db, makeConfig({ timezone: "UTC" }));
    expect(view.source.timezone).toBe("gui");
    expect(view.timezone).toBe(""); // explicit empty wins — ops decision
  });
});

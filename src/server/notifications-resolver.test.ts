import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";
import { getEffectiveNotifications, getGlobalNotifications } from "./notifications-resolver.js";
import type { Config } from "../config/schema.js";

const baseConfig: Config = {
  webhook: { slackWebhookUrl: undefined } as any,
  notifications: { email: { from: "x", appBaseUrl: "x" } } as any,
} as Config;

describe("getEffectiveNotifications — priority chain", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("default (no settings, no config) returns built-in defaults with source=default", () => {
    const got = getEffectiveNotifications(db, "stk-1", baseConfig);
    expect(got.slack.webhookUrl).toEqual({ value: null, source: "default" });
    expect(got.slack.enabled).toEqual({ value: false, source: "default" });
    expect(got.slack.onScanComplete).toEqual({ value: "hits-only", source: "default" });
    expect(got.email.enabled).toEqual({ value: false, source: "default" });
  });

  it("config.yaml-only values surface as source=config", () => {
    const cfg: Config = { ...baseConfig, webhook: { slackWebhookUrl: "https://hooks.example.com/c" } } as any;
    const got = getEffectiveNotifications(db, "stk-1", cfg);
    expect(got.slack.webhookUrl).toEqual({ value: "https://hooks.example.com/c", source: "config" });
  });

  it("settings (gui-global) wins over config.yaml — source=global", () => {
    db.setSetting("notifications.slack.webhookUrl", "https://hooks.example.com/g");
    const cfg: Config = { ...baseConfig, webhook: { slackWebhookUrl: "https://hooks.example.com/c" } } as any;
    const got = getEffectiveNotifications(db, "stk-1", cfg);
    expect(got.slack.webhookUrl).toEqual({ value: "https://hooks.example.com/g", source: "global" });
  });

  it("stack_settings wins over settings — source=override", () => {
    db.setSetting("notifications.slack.webhookUrl", "https://hooks.example.com/g");
    db.setStackSetting("stk-1", "notifications.slack.webhookUrl", "https://hooks.example.com/o");
    const got = getEffectiveNotifications(db, "stk-1", baseConfig);
    expect(got.slack.webhookUrl).toEqual({ value: "https://hooks.example.com/o", source: "override" });
  });

  it("stack-A override does not affect stack-B", () => {
    db.setStackSetting("stk-A", "notifications.slack.webhookUrl", "https://hooks.example.com/a");
    const a = getEffectiveNotifications(db, "stk-A", baseConfig);
    const b = getEffectiveNotifications(db, "stk-B", baseConfig);
    expect(a.slack.webhookUrl.value).toBe("https://hooks.example.com/a");
    expect(b.slack.webhookUrl.value).toBeNull();
    expect(b.slack.webhookUrl.source).toBe("default");
  });

  it("recipients = global + own pinned, exclude other stacks", () => {
    db.createEmailRecipient({ address: "g@x", minSeverity: "high", allowedSources: ["scan"], enabled: true });
    db.createEmailRecipient({ address: "p@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-prod" });
    db.createEmailRecipient({ address: "s@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-staging" });
    const got = getEffectiveNotifications(db, "stk-prod", baseConfig);
    expect(got.email.recipients.map((r) => r.address).sort()).toEqual(["g@x", "p@x"]);
    expect(got.email.recipients.find((r) => r.address === "g@x")?.scope).toBe("global");
    expect(got.email.recipients.find((r) => r.address === "p@x")?.scope).toBe("stack");
  });

  it("config.yaml notifications.email.enabled surfaces as source=config", () => {
    const cfg: Config = {
      ...baseConfig,
      notifications: { email: { enabled: true, from: "x", appBaseUrl: "x" } } as any,
    } as Config;
    const got = getEffectiveNotifications(db, "stk-1", cfg);
    expect(got.email.enabled).toEqual({ value: true, source: "config" });
  });

  it("boolean parses correctly: 'true'/'false' from settings", () => {
    db.setSetting("notifications.slack.enabled", "true");
    db.setSetting("notifications.email.enabled", "false");
    const got = getEffectiveNotifications(db, "stk-1", baseConfig);
    expect(got.slack.enabled).toEqual({ value: true, source: "global" });
    expect(got.email.enabled).toEqual({ value: false, source: "global" });
  });

  it("slack.enabled defaults to true when a URL is in effect (legacy convention)", () => {
    // URL from config.yaml, enabled flag not set anywhere
    const cfg: Config = { ...baseConfig, webhook: { slackWebhookUrl: "https://hooks.example.com/c" } } as any;
    const got = getEffectiveNotifications(db, "stk-1", cfg);
    expect(got.slack.webhookUrl).toEqual({ value: "https://hooks.example.com/c", source: "config" });
    expect(got.slack.enabled).toEqual({ value: true, source: "default" });
  });

  it("slack.enabled false override beats URL-implies-enabled default", () => {
    db.setSetting("notifications.slack.webhookUrl", "https://hooks.example.com/g");
    db.setSetting("notifications.slack.enabled", "false");
    const got = getEffectiveNotifications(db, "stk-1", baseConfig);
    expect(got.slack.enabled).toEqual({ value: false, source: "global" });
  });
});

describe("getGlobalNotifications — global-only view", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => { db.close(); });

  it("ignores per-stack overrides — returns the global value, not the override", () => {
    // The bug: with a stack override AND a global value, the per-stack view
    // surfaces the override, hiding any global edit. The global-only view
    // must skip the override layer entirely.
    db.setSetting("notifications.slack.enabled", "false");
    db.setStackSetting("stk-1", "notifications.slack.enabled", "true");

    const eff = getEffectiveNotifications(db, "stk-1", baseConfig);
    expect(eff.slack.enabled).toEqual({ value: true, source: "override" });

    const glob = getGlobalNotifications(db, baseConfig);
    expect(glob.slack.enabled).toEqual({ value: false, source: "global" });
  });

  it("ignores per-stack webhook override — returns the global webhook URL", () => {
    db.setSetting("notifications.slack.webhookUrl", "https://hooks.example.com/g");
    db.setStackSetting("stk-1", "notifications.slack.webhookUrl", "https://hooks.example.com/o");
    const glob = getGlobalNotifications(db, baseConfig);
    expect(glob.slack.webhookUrl).toEqual({ value: "https://hooks.example.com/g", source: "global" });
  });

  it("falls through to config when no global value is set", () => {
    const cfg: Config = { ...baseConfig, webhook: { slackWebhookUrl: "https://hooks.example.com/c" } } as any;
    db.setStackSetting("stk-1", "notifications.slack.webhookUrl", "https://hooks.example.com/o");
    const glob = getGlobalNotifications(db, cfg);
    expect(glob.slack.webhookUrl).toEqual({ value: "https://hooks.example.com/c", source: "config" });
  });

  it("falls through to default when nothing is set", () => {
    db.setStackSetting("stk-1", "notifications.slack.webhookUrl", "https://hooks.example.com/o");
    const glob = getGlobalNotifications(db, baseConfig);
    expect(glob.slack.webhookUrl).toEqual({ value: null, source: "default" });
    expect(glob.slack.enabled).toEqual({ value: false, source: "default" });
    expect(glob.slack.onScanComplete).toEqual({ value: "hits-only", source: "default" });
    expect(glob.email.enabled).toEqual({ value: false, source: "default" });
  });

  it("ignores per-stack onScanComplete override", () => {
    db.setSetting("notifications.slack.onScanComplete", "always");
    db.setStackSetting("stk-1", "notifications.slack.onScanComplete", "off");
    const glob = getGlobalNotifications(db, baseConfig);
    expect(glob.slack.onScanComplete).toEqual({ value: "always", source: "global" });
  });

  it("recipients = global only, no stack-pinned rows", () => {
    db.createEmailRecipient({ address: "g@x", minSeverity: "high", allowedSources: ["scan"], enabled: true });
    db.createEmailRecipient({ address: "p@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-1" });
    db.createEmailRecipient({ address: "s@x", minSeverity: "high", allowedSources: ["scan"], enabled: true, stackId: "stk-2" });
    const glob = getGlobalNotifications(db, baseConfig);
    expect(glob.email.recipients.map((r) => r.address)).toEqual(["g@x"]);
    expect(glob.email.recipients[0]!.scope).toBe("global");
  });

  it("includes disabled global recipients (admin view, not delivery view)", () => {
    db.createEmailRecipient({ address: "a@x", minSeverity: "high", allowedSources: ["scan"], enabled: false });
    db.createEmailRecipient({ address: "b@x", minSeverity: "high", allowedSources: ["scan"], enabled: true });
    const glob = getGlobalNotifications(db, baseConfig);
    expect(glob.email.recipients.map((r) => r.address).sort()).toEqual(["a@x", "b@x"]);
  });

  it("config.yaml notifications.email.enabled surfaces as source=config when no global is set", () => {
    const cfg: Config = {
      ...baseConfig,
      notifications: { email: { enabled: true, from: "x", appBaseUrl: "x" } } as any,
    } as Config;
    db.setStackSetting("stk-1", "notifications.email.enabled", "false");
    const glob = getGlobalNotifications(db, cfg);
    expect(glob.email.enabled).toEqual({ value: true, source: "config" });
  });
});

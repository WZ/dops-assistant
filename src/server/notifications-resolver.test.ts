import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";
import { getEffectiveNotifications } from "./notifications-resolver.js";
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

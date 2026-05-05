import type { Database } from "./db.js";
import type { Config } from "../config/schema.js";
import type { EmailRecipient } from "../types/notifications.js";

export type FieldSource = "override" | "global" | "config" | "default";

export interface FieldWithSource<T> {
  value: T;
  source: FieldSource;
}

export type SlackOnScanComplete = "always" | "hits-only" | "off";

export interface EffectiveNotifications {
  slack: {
    webhookUrl: FieldWithSource<string | null>;
    enabled: FieldWithSource<boolean>;
    onScanComplete: FieldWithSource<SlackOnScanComplete>;
  };
  email: {
    enabled: FieldWithSource<boolean>;
    recipients: EmailRecipient[]; // each carries .scope from the db layer
  };
}

const ON_SCAN_COMPLETE_VALUES: ReadonlySet<SlackOnScanComplete> =
  new Set(["always", "hits-only", "off"]);

function parseBool(s: string | undefined): boolean | undefined {
  if (s === undefined) return undefined;
  if (s === "true") return true;
  if (s === "false") return false;
  return undefined;
}

function resolveString(
  db: Database,
  stackId: string,
  key: string,
  configValue: string | null | undefined,
  defaultValue: string | null,
): FieldWithSource<string | null> {
  const override = db.getStackSetting(stackId, key);
  if (override !== undefined) return { value: override, source: "override" };
  const global = db.getSetting(key);
  if (global !== undefined) return { value: global, source: "global" };
  if (configValue !== undefined && configValue !== null) {
    return { value: configValue, source: "config" };
  }
  return { value: defaultValue, source: "default" };
}

function resolveBool(
  db: Database,
  stackId: string,
  key: string,
  configValue: boolean | undefined,
  defaultValue: boolean,
): FieldWithSource<boolean> {
  const override = parseBool(db.getStackSetting(stackId, key));
  if (override !== undefined) return { value: override, source: "override" };
  const global = parseBool(db.getSetting(key));
  if (global !== undefined) return { value: global, source: "global" };
  if (configValue !== undefined) return { value: configValue, source: "config" };
  return { value: defaultValue, source: "default" };
}

function resolveOnScanComplete(
  db: Database,
  stackId: string,
): FieldWithSource<SlackOnScanComplete> {
  const key = "notifications.slack.onScanComplete";
  const override = db.getStackSetting(stackId, key);
  if (override !== undefined && ON_SCAN_COMPLETE_VALUES.has(override as SlackOnScanComplete)) {
    return { value: override as SlackOnScanComplete, source: "override" };
  }
  const global = db.getSetting(key);
  if (global !== undefined && ON_SCAN_COMPLETE_VALUES.has(global as SlackOnScanComplete)) {
    return { value: global as SlackOnScanComplete, source: "global" };
  }
  return { value: "hits-only", source: "default" };
}

export function getEffectiveNotifications(
  db: Database,
  stackId: string,
  config: Config,
): EffectiveNotifications {
  const slackConfigUrl = config.webhook?.slackWebhookUrl ?? null;
  const slackUrl = resolveString(db, stackId, "notifications.slack.webhookUrl", slackConfigUrl, null);

  return {
    slack: {
      webhookUrl: slackUrl,
      // Legacy convention: a URL in effect (from any source) implies enabled
      // unless an explicit override/global/config says otherwise.
      enabled:    resolveBool(db, stackId, "notifications.slack.enabled", undefined, !!slackUrl.value),
      onScanComplete: resolveOnScanComplete(db, stackId),
    },
    email: {
      enabled:  resolveBool(db, stackId, "notifications.email.enabled", config.notifications?.email?.enabled, false),
      recipients: db.listEmailRecipientsForStack(stackId, { enabledOnly: false }),
    },
  };
}

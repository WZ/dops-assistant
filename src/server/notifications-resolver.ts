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

interface StringLayers {
  /** Per-stack override value. `undefined` means "no override layer" (e.g. global view). */
  override?: string;
  /** GUI global setting value. `undefined` means "no global value set". */
  global?: string;
}

function resolveStringFrom(
  layers: StringLayers,
  configValue: string | null | undefined,
  defaultValue: string | null,
): FieldWithSource<string | null> {
  if (layers.override !== undefined) return { value: layers.override, source: "override" };
  if (layers.global !== undefined) return { value: layers.global, source: "global" };
  if (configValue !== undefined && configValue !== null) {
    return { value: configValue, source: "config" };
  }
  return { value: defaultValue, source: "default" };
}

function resolveBoolFrom(
  layers: StringLayers,
  configValue: boolean | undefined,
  defaultValue: boolean,
): FieldWithSource<boolean> {
  const override = parseBool(layers.override);
  if (override !== undefined) return { value: override, source: "override" };
  const global = parseBool(layers.global);
  if (global !== undefined) return { value: global, source: "global" };
  if (configValue !== undefined) return { value: configValue, source: "config" };
  return { value: defaultValue, source: "default" };
}

function resolveOnScanCompleteFrom(layers: StringLayers): FieldWithSource<SlackOnScanComplete> {
  if (layers.override !== undefined && ON_SCAN_COMPLETE_VALUES.has(layers.override as SlackOnScanComplete)) {
    return { value: layers.override as SlackOnScanComplete, source: "override" };
  }
  if (layers.global !== undefined && ON_SCAN_COMPLETE_VALUES.has(layers.global as SlackOnScanComplete)) {
    return { value: layers.global as SlackOnScanComplete, source: "global" };
  }
  return { value: "hits-only", source: "default" };
}

/**
 * Build a layers object for a given setting key. When `stackId` is provided,
 * the per-stack override row is consulted; otherwise the override layer is
 * skipped entirely (used by `getGlobalNotifications`).
 */
function readLayers(db: Database, stackId: string | null, key: string): StringLayers {
  const override = stackId !== null ? db.getStackSetting(stackId, key) : undefined;
  const global = db.getSetting(key);
  return { override, global };
}

export function getEffectiveNotifications(
  db: Database,
  stackId: string,
  config: Config,
): EffectiveNotifications {
  const slackConfigUrl = config.webhook?.slackWebhookUrl ?? null;
  const slackUrl = resolveStringFrom(
    readLayers(db, stackId, "notifications.slack.webhookUrl"),
    slackConfigUrl,
    null,
  );

  return {
    slack: {
      webhookUrl: slackUrl,
      // Legacy convention: a URL in effect (from any source) implies enabled
      // unless an explicit override/global/config says otherwise.
      enabled: resolveBoolFrom(
        readLayers(db, stackId, "notifications.slack.enabled"),
        undefined,
        !!slackUrl.value,
      ),
      onScanComplete: resolveOnScanCompleteFrom(
        readLayers(db, stackId, "notifications.slack.onScanComplete"),
      ),
    },
    email: {
      enabled: resolveBoolFrom(
        readLayers(db, stackId, "notifications.email.enabled"),
        config.notifications?.email?.enabled,
        false,
      ),
      recipients: db.listEmailRecipientsForStack(stackId, { enabledOnly: false }),
    },
  };
}

/**
 * Returns the same shape as `getEffectiveNotifications` but built without
 * consulting any per-stack override row. Used by the GUI's global-edit mode
 * so the form reflects the global layer (config/default fallthrough) rather
 * than whatever the active stack happens to override.
 *
 * Without this, toggling a field in global-edit mode while the active stack
 * has its own override would appear to do nothing — the PUT would update the
 * global setting correctly, but the subsequent GET (the per-stack effective
 * view) would still surface the stack's override and the form would snap back.
 */
export function getGlobalNotifications(db: Database, config: Config): EffectiveNotifications {
  const slackConfigUrl = config.webhook?.slackWebhookUrl ?? null;
  const slackUrl = resolveStringFrom(
    readLayers(db, null, "notifications.slack.webhookUrl"),
    slackConfigUrl,
    null,
  );

  return {
    slack: {
      webhookUrl: slackUrl,
      enabled: resolveBoolFrom(
        readLayers(db, null, "notifications.slack.enabled"),
        undefined,
        !!slackUrl.value,
      ),
      onScanComplete: resolveOnScanCompleteFrom(
        readLayers(db, null, "notifications.slack.onScanComplete"),
      ),
    },
    email: {
      enabled: resolveBoolFrom(
        readLayers(db, null, "notifications.email.enabled"),
        config.notifications?.email?.enabled,
        false,
      ),
      // Globals only — drop any rows pinned to a stack.
      recipients: db
        .listEmailRecipients({ enabledOnly: false })
        .filter((r) => r.scope === "global"),
    },
  };
}

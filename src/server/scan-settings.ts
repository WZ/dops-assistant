/**
 * scan-settings — effective-config resolver for the scan feature.
 *
 * The scan config has two sources:
 *   1. config.yaml (`config.scan.*`) — the startup defaults, the place to
 *      define probe rules, thresholds, and anything not flipped per-operator.
 *   2. db.settings (`scan.enabled`, `scan.cron`, `scan.timezone`) — the
 *      small subset the GUI exposes as user-editable. Stored as strings
 *      in the existing key/value settings table (same pattern as
 *      `notifications.slack.*`). GUI overrides always win over config.yaml.
 *
 * Keep the GUI-editable surface small. Everything beyond enabled/cron/timezone
 * stays config.yaml-only until there's a concrete ask. Rule editing in
 * particular is real complexity (threshold DSL, PromQL validation) that
 * doesn't belong in v1.
 */

import type { Config, ScanConfig } from "../config/schema.js";
import type { Database } from "./db.js";

/** DB setting keys — stringly typed on purpose since `db.settings` is key/value */
export const SCAN_SETTING_KEYS = {
  enabled: "scan.enabled",
  cron: "scan.cron",
  timezone: "scan.timezone",
} as const;

export type ScanSettingSource = "gui" | "config";

export interface ScanSettingsView {
  enabled: boolean;
  cron: string;
  timezone: string;
  /** Where each editable field's effective value came from. */
  source: {
    enabled: ScanSettingSource;
    cron: ScanSettingSource;
    timezone: ScanSettingSource;
  };
}

/**
 * Merge `db.settings` overrides on top of `config.scan`. Returns a complete
 * ScanConfig — probe rules, dedup window, cap etc. always come from
 * config.yaml since they aren't GUI-editable in v1.
 */
export function getEffectiveScanConfig(db: Database, config: Config): ScanConfig {
  const base = config.scan;
  const dbEnabled = db.getSetting(SCAN_SETTING_KEYS.enabled);
  const dbCron = db.getSetting(SCAN_SETTING_KEYS.cron);
  const dbTimezone = db.getSetting(SCAN_SETTING_KEYS.timezone);

  return {
    ...base,
    enabled: dbEnabled !== undefined ? dbEnabled === "true" : base.enabled,
    cron: dbCron ?? base.cron,
    timezone: dbTimezone ?? base.timezone,
  };
}

/**
 * Return the view that the GET /api/scan/settings endpoint serializes — the
 * effective values plus per-field `source` (so the UI can show a "from
 * config.yaml" badge when an override isn't set). Matches the slack-settings
 * response shape.
 */
export function getScanSettingsView(db: Database, config: Config): ScanSettingsView {
  const dbEnabled = db.getSetting(SCAN_SETTING_KEYS.enabled);
  const dbCron = db.getSetting(SCAN_SETTING_KEYS.cron);
  const dbTimezone = db.getSetting(SCAN_SETTING_KEYS.timezone);
  const eff = getEffectiveScanConfig(db, config);
  return {
    enabled: eff.enabled,
    cron: eff.cron,
    timezone: eff.timezone,
    source: {
      enabled: dbEnabled !== undefined ? "gui" : "config",
      cron: dbCron !== undefined ? "gui" : "config",
      timezone: dbTimezone !== undefined ? "gui" : "config",
    },
  };
}

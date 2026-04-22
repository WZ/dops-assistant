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

import type { Config, ProbeMetricRule, ScanConfig } from "../config/schema.js";
import { createLogger } from "../logger.js";
import type { Database } from "./db.js";

const logger = createLogger();

/** DB setting keys — stringly typed on purpose since `db.settings` is key/value */
export const SCAN_SETTING_KEYS = {
  enabled: "scan.enabled",
  cron: "scan.cron",
  timezone: "scan.timezone",
  /**
   * Probe rules stored as a JSON-encoded array. When present + valid,
   * REPLACES `config.scan.probe.metrics` wholesale. We don't merge per-rule
   * because rule identity is the `name` field, and partial merges create
   * ambiguity over what "inherited" vs "overridden" means.
   */
  probeMetrics: "scan.probe.metrics",
} as const;

export type ScanSettingSource = "gui" | "config";

export interface ScanSettingsView {
  enabled: boolean;
  cron: string;
  timezone: string;
  /** Effective probe rules — either the DB override or config.yaml defaults. */
  rules: ProbeMetricRule[];
  /** Where each editable field's effective value came from. */
  source: {
    enabled: ScanSettingSource;
    cron: ScanSettingSource;
    timezone: ScanSettingSource;
    rules: ScanSettingSource;
  };
}

/**
 * Parse the probe-rules DB setting. Returns null on any parse / type error —
 * caller falls back to config.yaml. We intentionally don't validate SHAPE here
 * (that's scan-rule-validator's job on write) since data already at rest was
 * validated when written. If somehow corrupt, fall back rather than crash.
 */
function parseProbeMetricsOverride(raw: string | undefined): ProbeMetricRule[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      logger.warn({ raw }, "scan-settings: probe.metrics override is not an array, ignoring");
      return null;
    }
    return parsed as ProbeMetricRule[];
  } catch (err) {
    logger.warn({ err, rawPreview: raw.slice(0, 100) }, "scan-settings: failed to parse probe.metrics override, falling back to config.yaml");
    return null;
  }
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
  const dbProbeMetrics = parseProbeMetricsOverride(db.getSetting(SCAN_SETTING_KEYS.probeMetrics));

  return {
    ...base,
    enabled: dbEnabled !== undefined ? dbEnabled === "true" : base.enabled,
    cron: dbCron ?? base.cron,
    timezone: dbTimezone ?? base.timezone,
    probe: dbProbeMetrics !== null
      ? { ...base.probe, metrics: dbProbeMetrics }
      : base.probe,
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
  const dbProbeMetrics = db.getSetting(SCAN_SETTING_KEYS.probeMetrics);
  const eff = getEffectiveScanConfig(db, config);
  return {
    enabled: eff.enabled,
    cron: eff.cron,
    timezone: eff.timezone,
    rules: eff.probe.metrics,
    source: {
      enabled: dbEnabled !== undefined ? "gui" : "config",
      cron: dbCron !== undefined ? "gui" : "config",
      timezone: dbTimezone !== undefined ? "gui" : "config",
      // "gui" only when DB has a parseable override; a malformed override
      // falls back to config, so we report the source the operator actually
      // sees (not where the bytes came from).
      rules: dbProbeMetrics !== undefined && parseProbeMetricsOverride(dbProbeMetrics) !== null ? "gui" : "config",
    },
  };
}

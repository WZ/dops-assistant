/**
 * k8s-events-settings — effective-config resolver for the K8sEventPoller.
 *
 * Mirrors scan-settings.ts. The k8sEvents config has two sources:
 *   1. config.yaml (`config.k8sEvents.*`) — startup defaults: bad reasons,
 *      ignore reasons, intervalSeconds, queryTimeoutMs, maxEventsPerTick.
 *      Stay config-only in v1; they're tuned once and rarely touched.
 *   2. db.settings (`k8sEvents.enabled`) — the only field the GUI exposes
 *      as user-editable in v1. Stored as a string in the existing key/value
 *      settings table. GUI override always wins over config.yaml.
 *
 * Keep the GUI-editable surface small. The bad-reason list, interval, etc.
 * stay config.yaml-only until there's a concrete operator ask.
 */

import type { Config, K8sEventsConfig } from "../config/schema.js";
import type { Database } from "./db.js";

export const K8S_EVENTS_SETTING_KEYS = {
  enabled: "k8sEvents.enabled",
} as const;

export type K8sEventsSettingSource = "gui" | "config";

export interface K8sEventsSettingsView {
  enabled: boolean;
  source: {
    enabled: K8sEventsSettingSource;
  };
}

/**
 * Merge `db.settings` overrides on top of `config.k8sEvents`. Returns a
 * complete K8sEventsConfig — every non-GUI-editable field comes from
 * config.yaml unchanged.
 */
export function getEffectiveK8sEventsConfig(db: Database, config: Config): K8sEventsConfig {
  const base = config.k8sEvents;
  const dbEnabled = db.getSetting(K8S_EVENTS_SETTING_KEYS.enabled);
  return {
    ...base,
    enabled: dbEnabled !== undefined ? dbEnabled === "true" : base.enabled,
  };
}

/**
 * Return the view that the GET /api/scan/settings endpoint embeds under the
 * `k8sEvents` key — effective values plus per-field `source` so the UI can
 * show a "from config.yaml" badge when no GUI override is set.
 */
export function getK8sEventsSettingsView(db: Database, config: Config): K8sEventsSettingsView {
  const dbEnabled = db.getSetting(K8S_EVENTS_SETTING_KEYS.enabled);
  const eff = getEffectiveK8sEventsConfig(db, config);
  return {
    enabled: eff.enabled,
    source: {
      enabled: dbEnabled !== undefined ? "gui" : "config",
    },
  };
}

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useStackContext } from "../contexts/StackContext";
import { RuleList } from "./scan/RuleList";
import type { RuleDraft } from "./scan/types";

/**
 * ScanTab — GUI for the proactive scan feature: toggle, cadence, and probe
 * rule editor. Live status (next run / last run / Scan now) lives in the
 * Operation Desk view; this tab is settings-only.
 *
 * GUI-editable: enabled, cron, timezone, probe rules. Everything else
 * (maxInvestigationsPerTick, dedupWindowMinutes, probe.concurrency,
 * probe.queryTimeoutMs) stays in config.yaml — low-touch operator knobs
 * that don't need a UI for every tweak.
 */

type Source = "gui" | "config";

interface ScanSettings {
  enabled: boolean;
  cron: string;
  timezone: string;
  rules: RuleDraft[];
  source: { enabled: Source; cron: Source; timezone: Source; rules: Source };
}

interface ValidationDetail {
  path: string;
  message: string;
}

const LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60";

const INPUT_CLASS =
  "w-full rounded-md border border-border/40 bg-card/50 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/15";

export function ScanTab() {
  const { stackFetch } = useStackContext();

  const [settings, setSettings] = useState<ScanSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Form state — diverges from `settings` once the user edits anything.
  const [enabledInput, setEnabledInput] = useState(false);
  const [cronInput, setCronInput] = useState("");
  const [timezoneInput, setTimezoneInput] = useState("");
  const [rulesInput, setRulesInput] = useState<RuleDraft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [ruleErrors, setRuleErrors] = useState<ValidationDetail[]>([]);

  const fetchAll = useCallback(async () => {
    try {
      const settingsRes = await stackFetch("/api/scan/settings");
      const settingsData = (await settingsRes.json()) as ScanSettings;
      setSettings(settingsData);
      // Only reset the form on first load or after a save (dirty=false).
      if (!dirty) {
        setEnabledInput(settingsData.enabled);
        setCronInput(settingsData.cron);
        setTimezoneInput(settingsData.timezone);
        setRulesInput(settingsData.rules);
      }
    } catch {
      /* network blip; leave prior state */
    }
    setLoading(false);
  }, [stackFetch, dirty]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setRuleErrors([]);
    try {
      const res = await stackFetch("/api/scan/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: enabledInput,
          cron: cronInput,
          timezone: timezoneInput,
          rules: rulesInput,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; details?: ValidationDetail[] | string[] };
        // Rule validation errors come back as { error: "Invalid probe rules",
        // details: [{path, message}, ...] }. Surface per-rule, don't stuff
        // into the generic top-level error banner.
        if (Array.isArray(err.details) && err.details.length > 0 && typeof err.details[0] === "object") {
          setRuleErrors(err.details as ValidationDetail[]);
          throw new Error(err.error || "Rule validation failed");
        }
        throw new Error(err.error || `Save failed: ${res.status}`);
      }
      setDirty(false);
      await fetchAll();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="p-6">
        <div
          className="h-32 rounded-lg"
          style={{
            background:
              "linear-gradient(90deg, hsl(var(--muted)) 25%, hsl(var(--secondary)) 50%, hsl(var(--muted)) 75%)",
            backgroundSize: "200% 100%",
            animation: "shimmer 1.6s infinite",
          }}
        />
      </div>
    );
  }

  const allFromConfig =
    settings?.source.enabled === "config" &&
    settings.source.cron === "config" &&
    settings.source.timezone === "config";

  return (
    <div className="p-6">
      {/* Section: SCAN */}
      <section aria-label="Proactive scan" className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            Proactive Scan
          </h2>
          {allFromConfig && (
            <span className="font-mono text-[9px] text-muted-foreground/40 ml-1">
              (all from config.yaml)
            </span>
          )}
        </div>

        <p className="text-xs text-muted-foreground/60 mb-4 max-w-2xl">
          Runs a cheap PromQL probe across every registered service on a cron
          schedule. Services that trip thresholds for the configured number of
          consecutive ticks get a focused investigation. Probe rules, thresholds,
          and caps live in <span className="font-mono text-[11px]">config.yaml</span>.
        </p>

        <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className={LABEL_CLASS}>Enabled</label>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                Fires the probe on the cron schedule. Off by default.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabledInput}
              aria-label="Enable proactive scan"
              onClick={() => {
                setEnabledInput(!enabledInput);
                setDirty(true);
              }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                enabledInput ? "bg-primary" : "bg-muted-foreground/20"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  enabledInput ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Cron */}
          <div>
            <label className={LABEL_CLASS}>Cron expression</label>
            <input
              type="text"
              value={cronInput}
              onChange={(e) => {
                setCronInput(e.target.value);
                setDirty(true);
              }}
              placeholder="0 */4 * * *"
              className={`${INPUT_CLASS} mt-1`}
              spellCheck={false}
            />
            <p className="text-[10px] text-muted-foreground/40 mt-1 font-mono">
              5-field cron (no seconds). Example: <span>0 */4 * * *</span> = every 4 hours.
            </p>
          </div>

          {/* Timezone */}
          <div>
            <label className={LABEL_CLASS}>Timezone</label>
            <input
              type="text"
              value={timezoneInput}
              onChange={(e) => {
                setTimezoneInput(e.target.value);
                setDirty(true);
              }}
              placeholder="UTC"
              className={`${INPUT_CLASS} mt-1`}
              spellCheck={false}
            />
            <p className="text-[10px] text-muted-foreground/40 mt-1 font-mono">
              IANA tz name (e.g. <span>UTC</span>, <span>America/New_York</span>). Defaults to UTC.
            </p>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="font-mono text-xs font-medium h-9 rounded-lg px-4"
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>

          {saveError && (
            <div className="text-xs font-mono px-3 py-2 rounded-md bg-destructive/10 text-destructive">
              {saveError}
            </div>
          )}
        </div>
      </section>

      {/* Section: RULES */}
      <section aria-label="Probe rules" className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            Probe rules
          </h2>
          {settings?.source.rules === "config" && (
            <span className="font-mono text-[9px] text-muted-foreground/40 ml-1">
              (from config.yaml)
            </span>
          )}
        </div>

        <p className="text-xs text-muted-foreground/60 mb-4 max-w-2xl">
          Each tick, the probe runs these rules against every registered service.
          A rule trips when its PromQL value crosses the threshold for the
          configured consecutive ticks. Use Test to dry-run a rule against live
          data before saving.
        </p>

        <RuleList
          rules={rulesInput}
          onChange={(next) => {
            setRulesInput(next);
            setDirty(true);
          }}
        />

        {ruleErrors.length > 0 && (
          <div className="mt-3 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 space-y-1">
            <div className="text-[11px] font-mono font-semibold text-destructive">
              {ruleErrors.length === 1 ? "1 rule error:" : `${ruleErrors.length} rule errors:`}
            </div>
            {ruleErrors.map((e, i) => (
              <div key={i} className="text-[11px] font-mono text-destructive/90">
                <span className="opacity-70">{e.path}:</span> {e.message}
              </div>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}

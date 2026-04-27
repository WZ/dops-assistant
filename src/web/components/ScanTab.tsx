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

interface K8sStackStatus {
  stackId: string;
  name: string;
  /** ISO timestamp; null when the poller has never completed a poll (disabled or just-started). */
  lastTickAt: string | null;
  /** null with lastTickAt set = poll succeeded. Non-null = the specific reason it can't run. */
  degradedReason: string | null;
}

interface K8sEventsSettings {
  enabled: boolean;
  source: { enabled: Source };
  stacks: K8sStackStatus[];
}

interface ScanSettings {
  enabled: boolean;
  cron: string;
  timezone: string;
  rules: RuleDraft[];
  source: { enabled: Source; cron: Source; timezone: Source; rules: Source };
  k8sEvents: K8sEventsSettings;
}

type K8sStatusTone = "ok" | "warn" | "neutral";

/**
 * Three-state status for a stack's K8sEventPoller. The UI distinguishes:
 *   - neutral: poller has never actually polled (toggle off or just-started).
 *     We can't claim "OK" because we haven't checked. Honest.
 *   - ok: last poll succeeded, k8s tools resolved.
 *   - warn: last poll surfaced a degraded reason; toggle won't take effect
 *     on this stack until that's fixed.
 */
function k8sStatusLabel(s: K8sStackStatus): { tone: K8sStatusTone; label: string } {
  if (s.lastTickAt === null) {
    return { tone: "neutral", label: "not yet polled — flip toggle on to check" };
  }
  if (s.degradedReason === null) {
    return { tone: "ok", label: "k8s provider detected" };
  }
  if (s.degradedReason === "infrastructure-role-not-resolved") {
    return { tone: "warn", label: "no infra MCP wired — toggle has no effect" };
  }
  if (s.degradedReason === "infrastructure-not-kubernetes") {
    return { tone: "warn", label: "infra MCP isn't kubernetes — toggle has no effect" };
  }
  if (s.degradedReason === "infrastructure-call-failed") {
    return { tone: "warn", label: "k8s tool call failed last poll — check MCP" };
  }
  return { tone: "warn", label: s.degradedReason };
}

interface ValidationDetail {
  path: string;
  message: string;
}

const LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60";

const INPUT_CLASS =
  "w-full rounded-md border border-border/40 bg-card/50 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/15";

const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Every 15 min", value: "*/15 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Every 4 hours", value: "0 */4 * * *" },
  { label: "Daily", value: "0 0 * * *" },
  { label: "Weekly", value: "0 9 * * 1" },
];

/**
 * Browser-detected IANA timezone. Falls back to null on older engines
 * where Intl.DateTimeFormat().resolvedOptions().timeZone isn't available.
 */
function detectBrowserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

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
  const [k8sEnabledInput, setK8sEnabledInput] = useState(false);
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
        // If the user has never saved a GUI timezone (still using the
        // config.yaml default), pre-fill with their browser timezone so the
        // cron schedule runs in local time by default instead of UTC. Users
        // who explicitly want UTC can clear the field and save.
        const browserTz = detectBrowserTimezone();
        if (settingsData.source.timezone === "config" && browserTz && browserTz !== settingsData.timezone) {
          setTimezoneInput(browserTz);
          setDirty(true);
        } else {
          setTimezoneInput(settingsData.timezone);
        }
        setRulesInput(settingsData.rules);
        setK8sEnabledInput(settingsData.k8sEvents.enabled);
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
          k8sEvents: { enabled: k8sEnabledInput },
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

        <p className="text-sm text-muted-foreground/70 mb-4 max-w-2xl">
          Automatically check every service on a schedule. When a service crosses
          a threshold for several scans in a row, a full investigation starts
          without anyone needing to click.
        </p>

        <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className={LABEL_CLASS}>Enabled</label>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                Scans only run while this is on.
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

          {/* Schedule */}
          <div>
            <label className={LABEL_CLASS}>Schedule</label>
            <div className="flex flex-wrap gap-1.5 mt-1.5 mb-2">
              {CRON_PRESETS.map((p) => {
                const active = cronInput.trim() === p.value;
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => {
                      setCronInput(p.value);
                      setDirty(true);
                    }}
                    className={
                      active
                        ? "px-2.5 py-1 text-[11px] font-mono rounded-md border border-primary/60 bg-primary/15 text-foreground"
                        : "px-2.5 py-1 text-[11px] font-mono rounded-md border border-border/40 bg-card/40 text-muted-foreground hover:border-border hover:text-foreground transition-colors"
                    }
                    title={p.value}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <input
              type="text"
              value={cronInput}
              onChange={(e) => {
                setCronInput(e.target.value);
                setDirty(true);
              }}
              placeholder="0 */4 * * *"
              className={INPUT_CLASS}
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground/50 mt-1.5">
              Pick a preset, or type a 5-field cron expression. Example: <span className="font-mono text-[11px]">0 */4 * * *</span> runs every 4 hours.
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
            <p className="text-xs text-muted-foreground/50 mt-1.5">
              Defaults to your browser's timezone. Accepts any IANA name like <span className="font-mono text-[11px]">America/New_York</span> or <span className="font-mono text-[11px]">UTC</span>.
            </p>
          </div>
        </div>
      </section>

      {/* Section: K8S EVENT POLLER */}
      <section aria-label="K8s event poller" className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            K8s Event Poller
          </h2>
          {settings?.k8sEvents.source.enabled === "config" && (
            <span className="font-mono text-[9px] text-muted-foreground/40 ml-1">
              (from config.yaml)
            </span>
          )}
        </div>

        <p className="text-sm text-muted-foreground/70 mb-4 max-w-2xl">
          Catch transient pod crashes the proactive scan misses. Polls the k8s
          API every 5 minutes for bad-reason events (OOMKilled, CrashLoopBackOff,
          ImagePullBackOff, etc.) and pod restart-count increments. Requires an
          infrastructure MCP that exposes <span className="font-mono text-[11px]">list_pods</span> + <span className="font-mono text-[11px]">list_events</span>.
        </p>

        <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className={LABEL_CLASS}>Enabled</label>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                Off by default. Flip on after wiring a k8s infrastructure MCP.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={k8sEnabledInput}
              aria-label="Enable k8s event poller"
              onClick={() => {
                setK8sEnabledInput(!k8sEnabledInput);
                setDirty(true);
              }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                k8sEnabledInput ? "bg-primary" : "bg-muted-foreground/20"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  k8sEnabledInput ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Per-stack live status */}
          {settings && settings.k8sEvents.stacks.length > 0 && (
            <div>
              <label className={LABEL_CLASS}>Per-stack status</label>
              <p className="text-xs text-muted-foreground/60 mt-0.5 mb-2">
                Live state from each stack&apos;s last poll. The toggle only
                takes effect on stacks with a working k8s provider.
              </p>
              <ul className="space-y-1.5">
                {settings.k8sEvents.stacks.map((s) => {
                  const status = k8sStatusLabel(s);
                  const dotClass =
                    status.tone === "ok" ? "bg-emerald-500"
                    : status.tone === "warn" ? "bg-amber-500"
                    : "bg-muted-foreground/40";
                  return (
                    <li
                      key={s.stackId}
                      className="flex items-center justify-between rounded-md border border-border/30 bg-card/30 px-3 py-2"
                    >
                      <span className="font-mono text-xs text-foreground">{s.name}</span>
                      <span className="flex items-center gap-2">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotClass}`} />
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {status.label}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
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

        <p className="text-sm text-muted-foreground/70 mb-4 max-w-2xl">
          Every scheduled scan runs these checks against each service. A check
          triggers when the query result crosses its threshold for the set
          number of scans in a row. Use <span className="text-foreground/80">Test</span> to try a check against live
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

      {/* Form-wide save action — saves all sections above (scan, k8s events, rules). */}
      <div className="flex items-center gap-3 pt-2">
        <Button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="font-mono text-xs font-medium h-9 rounded-lg px-4"
        >
          {saving ? "Saving..." : "Save"}
        </Button>
        {saveError && (
          <div className="text-xs font-mono px-3 py-2 rounded-md bg-destructive/10 text-destructive">
            {saveError}
          </div>
        )}
      </div>
    </div>
  );
}

// src/web/components/DiscoveryTab.tsx
//
// Periodic-discovery settings tab. Shares ScanTab's visual language:
// page-level h1 + subtitle, Save chip top-right, vertical primary-bar section
// headers, card-wrapped form, custom toggle switch instead of native checkbox,
// cron presets, embedded inbox + recent runs sections.

import { useEffect, useState } from "react";
import { useStackContext } from "../contexts/StackContext";
import { Button } from "@/components/ui/button";
import { DiscoveriesPage } from "./DiscoveriesPage";

interface Settings {
  enabled: boolean;
  cron: string;
  timezone: string;
  consensusRuns: number;
  consensusRunsForRemovals: number;
}

interface RunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failed" | "skipped";
  serviceCount: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  error: string | null;
}

const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  cron: "",
  timezone: "UTC",
  consensusRuns: 2,
  consensusRunsForRemovals: 3,
};

const LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60";

const INPUT_CLASS =
  "w-full rounded-md border border-border/40 bg-card/50 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/15";

const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Every 12 hours", value: "0 */12 * * *" },
  { label: "Daily 3am", value: "0 3 * * *" },
  { label: "Weekly", value: "0 3 * * 1" },
];

function detectBrowserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function DiscoveryTab() {
  const { stackFetch } = useStackContext();

  const [settings, setSettings] = useState<Settings | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [enabledInput, setEnabledInput] = useState(false);
  const [cronInput, setCronInput] = useState("");
  const [timezoneInput, setTimezoneInput] = useState("");
  const [additionsInput, setAdditionsInput] = useState(2);
  const [removalsInput, setRemovalsInput] = useState(3);
  const [dirty, setDirty] = useState(false);

  const reloadRuns = () => {
    stackFetch("/api/discoveries/runs?limit=10")
      .then((r) => (r.ok ? r.json() : []))
      .then(setRuns)
      .catch(() => {});
  };

  useEffect(() => {
    stackFetch("/api/discovery/settings")
      .then((r) => r.json())
      .then((s: Settings) => {
        setSettings(s);
        setEnabledInput(s.enabled);
        setCronInput(s.cron);
        setTimezoneInput(s.timezone || detectBrowserTimezone() || "UTC");
        setAdditionsInput(s.consensusRuns);
        setRemovalsInput(s.consensusRunsForRemovals);
      })
      .catch(() => {
        setSettings(DEFAULT_SETTINGS);
        setEnabledInput(DEFAULT_SETTINGS.enabled);
        setCronInput(DEFAULT_SETTINGS.cron);
        setTimezoneInput(detectBrowserTimezone() || "UTC");
        setAdditionsInput(DEFAULT_SETTINGS.consensusRuns);
        setRemovalsInput(DEFAULT_SETTINGS.consensusRunsForRemovals);
      });
    reloadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setSaveError(null);
    const res = await stackFetch("/api/discovery/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: enabledInput,
        cron: cronInput,
        timezone: timezoneInput,
        consensusRuns: additionsInput,
        consensusRunsForRemovals: removalsInput,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setSaveError(body.error ?? `save failed (${res.status})`);
      return;
    }
    setDirty(false);
    const next = await res.json().catch(() => null);
    if (next) setSettings(next);
  };

  const handleRunNow = async () => {
    setRunning(true);
    setSaveError(null);
    const res = await stackFetch("/api/discoveries/run-now", { method: "POST" });
    setRunning(false);
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      setSaveError(`Tick already in progress (next eligible: ${body.nextEligibleAt ?? "soon"})`);
      return;
    }
    if (!res.ok) {
      setSaveError(`run-now failed (${res.status})`);
      return;
    }
    setTimeout(reloadRuns, 800);
  };

  if (!settings) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div>
      {/* Page header — h1 left, Save (and Run now) on the right */}
      <div className="mb-6 animate-fade-up flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90">
            Discovery
          </h1>
          <p className="text-xs font-mono text-muted-foreground/70 mt-1 tracking-wide">
            Scheduled service discovery — suggests additions and removals for review
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {saveError && (
            <div className="text-xs font-mono px-3 py-2 rounded-md bg-destructive/10 text-destructive">
              {saveError}
            </div>
          )}
          <Button
            variant="outline"
            onClick={handleRunNow}
            disabled={running}
            className="font-mono text-xs font-medium h-9 rounded-lg px-4"
          >
            {running ? "Starting..." : "Run now"}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="font-mono text-xs font-medium h-9 rounded-lg px-4"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {/* Section: PERIODIC DISCOVERY */}
      <section aria-label="Periodic discovery" className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            Periodic Discovery
          </h2>
        </div>

        <p className="text-xs text-muted-foreground/60 mb-3 max-w-2xl">
          Re-runs the AI discovery agent on a schedule. New services appear in the inbox below as suggestions; existing services that go missing for several runs in a row appear as removal candidates. Nothing changes <span className="font-mono text-[11px]">services.yaml</span> until you accept.
        </p>

        <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className={LABEL_CLASS}>Enabled</label>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                Periodic discovery only runs while this is on.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabledInput}
              aria-label="Enable periodic discovery"
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
                        ? "px-3 py-1 text-[11px] font-mono rounded-md border border-primary/30 bg-primary/10 text-primary"
                        : "px-3 py-1 text-[11px] font-mono rounded-md border border-border/40 bg-card/40 text-muted-foreground hover:border-border hover:text-foreground transition-colors"
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
              placeholder="0 3 * * *"
              className={INPUT_CLASS}
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground/50 mt-1.5">
              Pick a preset, or type a 5-field cron expression. Example: <span className="font-mono text-[11px]">0 3 * * *</span> runs daily at 3am.
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

          {/* Consensus thresholds */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={LABEL_CLASS}>Consensus (additions)</label>
              <input
                type="number"
                min={1}
                max={10}
                value={additionsInput}
                onChange={(e) => {
                  setAdditionsInput(parseInt(e.target.value, 10) || 2);
                  setDirty(true);
                }}
                className={`${INPUT_CLASS} mt-1`}
              />
              <p className="text-xs text-muted-foreground/50 mt-1.5">
                A new service must appear in this many runs before it's suggested.
              </p>
            </div>
            <div>
              <label className={LABEL_CLASS}>Consensus (removals)</label>
              <input
                type="number"
                min={1}
                max={10}
                value={removalsInput}
                onChange={(e) => {
                  setRemovalsInput(parseInt(e.target.value, 10) || 3);
                  setDirty(true);
                }}
                className={`${INPUT_CLASS} mt-1`}
              />
              <p className="text-xs text-muted-foreground/50 mt-1.5">
                Existing services must be missing this many runs in a row before removal is suggested. Higher than additions to absorb LLM drift.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Section: INBOX */}
      <section aria-label="Discovery inbox" className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            Inbox
          </h2>
        </div>

        <p className="text-xs text-muted-foreground/60 mb-3 max-w-2xl">
          Pending suggestions from periodic discovery. Accept to register or unregister, dismiss to silence by name.
        </p>

        <div className="rounded-lg border border-border/40 bg-card/50 p-3">
          <DiscoveriesPage embedded />
        </div>
      </section>

      {/* Section: RECENT RUNS */}
      <section aria-label="Recent discovery runs" className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            Recent Runs
          </h2>
        </div>

        <p className="text-xs text-muted-foreground/60 mb-3 max-w-2xl">
          The last 10 runs, with status, services seen, token usage, and any error. Click <span className="font-mono text-[11px]">Run now</span> above to trigger an off-schedule tick.
        </p>

        <div className="rounded-lg border border-border/40 bg-card/50 p-4">
          {runs.length === 0 ? (
            <div className="text-xs font-mono text-muted-foreground/60 py-2">
              No runs yet.
            </div>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-left text-muted-foreground/60 border-b border-border/40">
                  <th className="py-2 pr-4 font-semibold uppercase tracking-[0.1em] text-[10px] whitespace-nowrap">Started</th>
                  <th className="py-2 pr-4 font-semibold uppercase tracking-[0.1em] text-[10px] whitespace-nowrap">Status</th>
                  <th className="py-2 pr-4 font-semibold uppercase tracking-[0.1em] text-[10px] whitespace-nowrap">Services</th>
                  <th className="py-2 pr-4 font-semibold uppercase tracking-[0.1em] text-[10px] whitespace-nowrap">Tokens (in/out)</th>
                  <th className="py-2 font-semibold uppercase tracking-[0.1em] text-[10px]">Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-border/20 last:border-b-0">
                    <td className="py-2 pr-4 whitespace-nowrap">{new Date(r.startedAt).toLocaleString()}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <span
                        className={
                          r.status === "success"
                            ? "text-success"
                            : r.status === "failed"
                              ? "text-destructive"
                              : r.status === "running"
                                ? "text-primary"
                                : "text-muted-foreground"
                        }
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{r.serviceCount ?? "—"}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {r.tokensInput ?? "—"}/{r.tokensOutput ?? "—"}
                    </td>
                    <td className="py-2 text-muted-foreground truncate max-w-[280px]">{r.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

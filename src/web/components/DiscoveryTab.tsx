// src/web/components/DiscoveryTab.tsx
//
// Periodic-discovery settings tab. Mirrors ScanTab: cron, timezone, consensus
// thresholds, plus a "Run now" button and a recent-runs panel.

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
  enabled: false, cron: "", timezone: "UTC", consensusRuns: 2, consensusRunsForRemovals: 3,
};

export function DiscoveryTab() {
  const { stackFetch } = useStackContext();
  const [s, setS] = useState<Settings | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadRuns = () => {
    stackFetch("/api/discoveries/runs?limit=10").then((r) => r.ok ? r.json() : []).then(setRuns).catch(() => {});
  };

  useEffect(() => {
    stackFetch("/api/discovery/settings").then((r) => r.json()).then(setS).catch(() => setS(DEFAULT_SETTINGS));
    reloadRuns();
  }, []);

  const save = async () => {
    if (!s) return;
    setSaving(true); setError(null);
    const res = await stackFetch("/api/discovery/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `save failed (${res.status})`);
    }
  };

  const runNow = async () => {
    const res = await stackFetch("/api/discoveries/run-now", { method: "POST" });
    if (res.status === 409) {
      const body = await res.json();
      setError(`Tick already in progress (next eligible: ${body.nextEligibleAt ?? "soon"})`);
      return;
    }
    setError(null);
    setTimeout(reloadRuns, 800);
  };

  if (!s) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-5 max-w-2xl">
      <section className="space-y-3">
        <h3 className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Periodic discovery</h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
          <span>Enabled</span>
        </label>
        <label className="block text-sm">
          <span className="block text-xs text-muted-foreground mb-1">Cron expression</span>
          <input
            type="text"
            value={s.cron}
            onChange={(e) => setS({ ...s, cron: e.target.value })}
            placeholder="0 3 * * *"
            className="w-full font-mono text-xs px-2 py-1.5 rounded border bg-background"
          />
        </label>
        <label className="block text-sm">
          <span className="block text-xs text-muted-foreground mb-1">Timezone</span>
          <input
            type="text"
            value={s.timezone}
            onChange={(e) => setS({ ...s, timezone: e.target.value })}
            className="w-full font-mono text-xs px-2 py-1.5 rounded border bg-background"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="block text-xs text-muted-foreground mb-1">Consensus (additions)</span>
            <input
              type="number" min={1} max={10}
              value={s.consensusRuns}
              onChange={(e) => setS({ ...s, consensusRuns: parseInt(e.target.value, 10) || 2 })}
              className="w-full font-mono text-xs px-2 py-1.5 rounded border bg-background"
            />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-muted-foreground mb-1">Consensus (removals)</span>
            <input
              type="number" min={1} max={10}
              value={s.consensusRunsForRemovals}
              onChange={(e) => setS({ ...s, consensusRunsForRemovals: parseInt(e.target.value, 10) || 3 })}
              className="w-full font-mono text-xs px-2 py-1.5 rounded border bg-background"
            />
          </label>
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          <Button size="sm" variant="outline" onClick={runNow}>Run now</Button>
        </div>
        {error && <div className="text-xs text-destructive">{error}</div>}
      </section>

      <section className="border-t border-border pt-5">
        <DiscoveriesPage />
      </section>

      <section className="border-t border-border pt-5">
        <h3 className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Recent runs</h3>
        {runs.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4">No runs yet.</div>
        ) : (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1">Started</th>
                <th className="py-1">Status</th>
                <th className="py-1">Services</th>
                <th className="py-1">Tokens (in/out)</th>
                <th className="py-1">Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b">
                  <td className="py-1">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="py-1">{r.status}</td>
                  <td className="py-1">{r.serviceCount ?? "—"}</td>
                  <td className="py-1">{r.tokensInput ?? "—"}/{r.tokensOutput ?? "—"}</td>
                  <td className="py-1 text-muted-foreground truncate max-w-[200px]">{r.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

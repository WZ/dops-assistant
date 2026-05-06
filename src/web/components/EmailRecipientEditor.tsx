import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ALL_SOURCES, type NotificationSource, type SeverityLevel } from "../../types/notifications.js";

type Severity = SeverityLevel;
type Source = NotificationSource;

interface Recipient {
  id: number;
  address: string;
  label?: string;
  minSeverity: Severity;
  allowedSources: Source[];
  enabled: boolean;
  stackId?: string | null;
  scope?: "global" | "stack";
}

interface Props {
  stackFetch: (path: string, init?: RequestInit) => Promise<Response>;
  existing: Recipient | null;
  onClose: () => void;
  onSaved: () => void;
}

const SOURCE_HELP: Record<Source, string> = {
  webhook: "Alertmanager webhook",
  scan: "Proactive scan (per-service)",
  "scan-run": "Scan run summary (per tick)",
  poller: "Health poller",
  "k8s-event-poller": "K8s event poller (transient pod crashes)",
  manual: "Manual investigation",
  "periodic-discovery": "Periodic service discovery",
};

const LABEL_CLASS =
  "block font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60 mb-1.5";
const INPUT_CLASS =
  "w-full h-9 px-3 rounded-lg border border-border/40 bg-background/40 text-xs text-foreground placeholder:text-muted-foreground/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function EmailRecipientEditor({ stackFetch, existing, onClose, onSaved }: Props) {
  const [address, setAddress] = useState(existing?.address ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [minSeverity, setMinSeverity] = useState<Severity>(existing?.minSeverity ?? "high");
  const [sources, setSources] = useState<Set<Source>>(new Set(existing?.allowedSources ?? ["webhook", "scan", "poller"]));
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleSource = (s: Source) => {
    const next = new Set(sources);
    next.has(s) ? next.delete(s) : next.add(s);
    setSources(next);
  };

  const save = async () => {
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { setError("Please enter a valid email address"); return; }
    if (sources.size === 0) { setError("Select at least one trigger source"); return; }
    setSaving(true);
    try {
      const body = {
        address,
        label: label || null,
        minSeverity,
        allowedSources: [...sources],
        enabled,
      };
      const res = existing
        ? await stackFetch(`/api/notifications/email/recipients/${existing.id}`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          })
        : await stackFetch("/api/notifications/email/recipients", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden" aria-label={existing ? "Edit recipient" : "Add recipient"}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/40 shrink-0">
        <Button
          variant="ghost"
          onClick={onClose}
          className="h-auto px-0 py-0 text-xs font-mono text-muted-foreground/60 hover:text-primary hover:bg-transparent transition-colors group"
        >
          <ArrowLeft size={12} className="!size-auto group-hover:-translate-x-0.5 transition-transform" />
          back to notifications
        </Button>
        <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
          {existing ? "Edit recipient" : "New Recipient"}
        </h2>
        <Button
          variant="outline"
          onClick={() => void save()}
          disabled={saving}
          className="px-3 py-1.5 h-auto text-[10px] font-mono bg-primary/10 border-primary/20 text-primary hover:bg-primary/15 hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : existing ? "Save" : "Create"}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          <div>
            <label className={LABEL_CLASS}>Email address</label>
            <input
              type="email"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="channel-name@org.onmicrosoft.com"
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label className={LABEL_CLASS}>Label (optional)</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="#sre-alerts"
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label className={LABEL_CLASS}>Minimum severity</label>
            <div className="flex gap-4 text-xs text-foreground">
              {(["low", "medium", "high", "critical"] as Severity[]).map((s) => (
                <label key={s} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="sev"
                    checked={minSeverity === s}
                    onChange={() => setMinSeverity(s)}
                    className="accent-primary"
                  />
                  {s}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className={LABEL_CLASS}>Trigger sources</label>
            <div className="grid grid-cols-2 gap-2 text-xs text-foreground">
              {ALL_SOURCES.map((s) => (
                <label key={s} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sources.has(s)}
                    onChange={() => toggleSource(s)}
                    className="accent-primary"
                  />
                  {SOURCE_HELP[s]}
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-primary"
            />
            Enabled
          </label>

          {error && <p className="font-mono text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}

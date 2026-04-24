import { useState } from "react";
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
  manual: "Manual investigation",
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={existing ? "Edit recipient" : "Add recipient"}
    >
      <div
        className="relative w-full max-w-md mx-4 rounded-lg border border-border/40 bg-card shadow-xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-4">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            {existing ? "Edit recipient" : "Add recipient"}
          </h3>
        </div>

        <label className={LABEL_CLASS}>Email address</label>
        <input
          type="email"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="channel-name@org.onmicrosoft.com"
          className={`${INPUT_CLASS} mb-3`}
        />

        <label className={LABEL_CLASS}>Label (optional)</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="#sre-alerts"
          className={`${INPUT_CLASS} mb-3`}
        />

        <label className={LABEL_CLASS}>Minimum severity</label>
        <div className="flex gap-4 mb-3 text-xs text-foreground">
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

        <label className={LABEL_CLASS}>Trigger sources</label>
        <div className="grid grid-cols-2 gap-2 mb-3 text-xs text-foreground">
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

        <label className="flex items-center gap-2 text-xs text-foreground mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="accent-primary"
          />
          Enabled
        </label>

        {error && <p className="font-mono text-xs text-destructive mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={onClose}
            className="font-mono text-xs font-medium h-9 rounded-lg px-3"
          >
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving}
            className="font-mono text-xs font-medium h-9 rounded-lg px-3"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

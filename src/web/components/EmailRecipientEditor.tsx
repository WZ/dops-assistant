import { useState } from "react";

type Severity = "low" | "medium" | "high" | "critical";
type Source = "webhook" | "scan" | "poller" | "manual";

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

const ALL_SOURCES: Source[] = ["webhook", "scan", "poller", "manual"];
const SOURCE_HELP: Record<Source, string> = {
  webhook: "Alertmanager webhook",
  scan: "Proactive scan",
  poller: "Health poller",
  manual: "Manual investigation",
};

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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold mb-4">{existing ? "Edit recipient" : "Add recipient"}</h3>

        <label className="block text-xs font-medium mb-1">Email address</label>
        <input
          type="email"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="channel-name@org.onmicrosoft.com"
          className="w-full h-9 px-3 rounded-lg border border-gray-300 text-xs mb-3"
        />

        <label className="block text-xs font-medium mb-1">Label (optional)</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="#sre-alerts"
          className="w-full h-9 px-3 rounded-lg border border-gray-300 text-xs mb-3"
        />

        <label className="block text-xs font-medium mb-1">Minimum severity</label>
        <div className="flex gap-3 mb-3 text-xs">
          {(["low", "medium", "high", "critical"] as Severity[]).map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input type="radio" name="sev" checked={minSeverity === s} onChange={() => setMinSeverity(s)} />
              {s}
            </label>
          ))}
        </div>

        <label className="block text-xs font-medium mb-1">Trigger sources</label>
        <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
          {ALL_SOURCES.map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input type="checkbox" checked={sources.has(s)} onChange={() => toggleSource(s)} />
              {SOURCE_HELP[s]}
            </label>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs mb-4">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>

        {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="h-9 px-3 rounded-lg border border-gray-300 text-xs hover:bg-gray-50">Cancel</button>
          <button onClick={() => void save()} disabled={saving}
            className="h-9 px-3 rounded-lg bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

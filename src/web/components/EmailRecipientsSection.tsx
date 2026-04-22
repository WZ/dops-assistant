import { useEffect, useState } from "react";
import { EmailRecipientEditor } from "./EmailRecipientEditor.js";

interface Recipient {
  id: number;
  address: string;
  label?: string;
  minSeverity: "low" | "medium" | "high" | "critical";
  allowedSources: Array<"webhook" | "scan" | "poller" | "manual">;
  enabled: boolean;
}

interface EmailConfig {
  enabled: boolean;
  recipients: Recipient[];
}

interface Props {
  stackFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

const SOURCE_LABELS: Record<Recipient["allowedSources"][number], string> = {
  webhook: "webhook",
  scan: "scan",
  poller: "poller",
  manual: "manual",
};

const SEVERITY_LABELS: Record<Recipient["minSeverity"], string> = {
  low: "low+",
  medium: "medium+",
  high: "high+",
  critical: "crit+",
};

export function EmailRecipientsSection({ stackFetch }: Props) {
  const [cfg, setCfg] = useState<EmailConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Recipient | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ id: number; ok: boolean; msg: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await stackFetch("/api/notifications/email");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCfg(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load email config");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const toggleGlobal = async (enabled: boolean) => {
    const res = await stackFetch("/api/notifications/email", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) await refresh();
  };

  const toggleRow = async (r: Recipient) => {
    const res = await stackFetch(`/api/notifications/email/recipients/${r.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !r.enabled }),
    });
    if (res.ok) await refresh();
  };

  const deleteRow = async (r: Recipient) => {
    if (!confirm(`Delete recipient "${r.label ?? r.address}"?`)) return;
    const res = await stackFetch(`/api/notifications/email/recipients/${r.id}`, { method: "DELETE" });
    if (res.ok) await refresh();
  };

  const testSend = async (r: Recipient) => {
    setTestingId(r.id);
    setTestResult(null);
    try {
      const res = await stackFetch("/api/notifications/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientId: r.id }),
      });
      const body = await res.json().catch(() => ({}));
      setTestResult({ id: r.id, ok: res.ok, msg: res.ok ? "Test email sent" : (body.error ?? `HTTP ${res.status}`) });
    } catch (e) {
      setTestResult({ id: r.id, ok: false, msg: e instanceof Error ? e.message : "Failed" });
    } finally {
      setTestingId(null);
    }
  };

  const openAdd = () => { setEditing(null); setEditorOpen(true); };
  const openEdit = (r: Recipient) => { setEditing(r); setEditorOpen(true); };

  if (loading && !cfg) return <div className="text-xs text-gray-500">Loading email settings…</div>;
  if (error) return <div className="text-xs text-red-600">Error: {error}</div>;
  if (!cfg) return <></>;

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Email</h3>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => void toggleGlobal(e.target.checked)} />
          Enable email notifications
        </label>
      </div>

      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-medium text-gray-700">Recipients</span>
          <button
            onClick={openAdd}
            className="h-9 px-3 rounded-lg bg-gray-900 text-white text-xs hover:bg-gray-700"
          >
            + Add recipient
          </button>
        </div>

        {cfg.recipients.length === 0 ? (
          <div className="px-4 py-6 text-xs text-gray-500 text-center">No recipients configured.</div>
        ) : (
          <ul className="divide-y divide-gray-200">
            {cfg.recipients.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                <div className="flex-1 min-w-0">
                  <div className="font-mono truncate">{r.label ?? r.address}</div>
                  {r.label && <div className="text-gray-500 truncate">{r.address}</div>}
                </div>
                <span className="text-gray-600">{SEVERITY_LABELS[r.minSeverity]}</span>
                <div className="flex gap-1">
                  {r.allowedSources.map((s) => (
                    <span key={s} className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-[10px]">
                      {SOURCE_LABELS[s]}
                    </span>
                  ))}
                </div>
                <label className="flex items-center">
                  <input type="checkbox" checked={r.enabled} onChange={() => void toggleRow(r)} />
                </label>
                <button onClick={() => void testSend(r)} disabled={testingId === r.id}
                  className="h-9 px-2 rounded-lg border border-gray-300 hover:bg-gray-50 text-xs">
                  {testingId === r.id ? "…" : "Test"}
                </button>
                <button onClick={() => openEdit(r)}
                  className="h-9 px-2 rounded-lg border border-gray-300 hover:bg-gray-50 text-xs">
                  Edit
                </button>
                <button onClick={() => void deleteRow(r)}
                  className="h-9 px-2 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 text-xs">
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {testResult && (
        <p className={`mt-2 text-xs ${testResult.ok ? "text-green-700" : "text-red-600"}`}>
          Recipient #{testResult.id}: {testResult.msg}
        </p>
      )}

      {editorOpen && (
        <EmailRecipientEditor
          stackFetch={stackFetch}
          existing={editing}
          onClose={() => setEditorOpen(false)}
          onSaved={() => { setEditorOpen(false); void refresh(); }}
        />
      )}
    </section>
  );
}

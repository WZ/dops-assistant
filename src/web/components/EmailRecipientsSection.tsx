import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NotificationSource, SeverityLevel } from "../../types/notifications.js";

export interface Recipient {
  id: number;
  address: string;
  label?: string;
  minSeverity: SeverityLevel;
  allowedSources: NotificationSource[];
  enabled: boolean;
  stackId?: string | null;
  scope?: "global" | "stack";
}

interface EmailConfig {
  enabled: boolean;
  recipients: Recipient[];
}

export interface EmailRecipientsSectionHandle {
  refresh: () => Promise<void>;
}

interface Props {
  stackFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onOpenEditor: (recipient: Recipient | null) => void;
  activeStackName?: string;
}

const SOURCE_LABELS: Record<NotificationSource, string> = {
  webhook: "webhook",
  scan: "scan",
  "scan-run": "scan-run",
  poller: "poller",
  "k8s-event-poller": "k8s-events",
  manual: "manual",
  "periodic-discovery": "discovery",
};

const SEVERITY_LABELS: Record<Recipient["minSeverity"], string> = {
  low: "low+",
  medium: "medium+",
  high: "high+",
  critical: "crit+",
};

const LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60";

export const EmailRecipientsSection = forwardRef<EmailRecipientsSectionHandle, Props>(function EmailRecipientsSection({ stackFetch, onOpenEditor, activeStackName }, ref) {
  const [cfg, setCfg] = useState<EmailConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingGlobal, setTogglingGlobal] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ id: number; ok: boolean; msg: string } | null>(null);
  const refreshRequestRef = useRef(0);
  const previousStackFetchRef = useRef(stackFetch);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await stackFetch("/api/notifications/email");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const nextCfg = await res.json();
      if (requestId === refreshRequestRef.current) setCfg(nextCfg);
    } catch (e) {
      if (requestId === refreshRequestRef.current) {
        setError(e instanceof Error ? e.message : "Failed to load email config");
      }
    } finally {
      if (requestId === refreshRequestRef.current) setLoading(false);
    }
  }, [stackFetch]);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);
  useEffect(() => {
    if (previousStackFetchRef.current !== stackFetch) {
      previousStackFetchRef.current = stackFetch;
      setCfg(null);
      setTestResult(null);
    }
    void refresh();
  }, [refresh, stackFetch]);

  const toggleGlobal = async (enabled: boolean) => {
    if (togglingGlobal) return;
    setTogglingGlobal(true);
    try {
      const res = await stackFetch("/api/notifications/email", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) await refresh();
    } finally {
      setTogglingGlobal(false);
    }
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

  if (loading && !cfg) {
    return <div className="font-mono text-xs text-muted-foreground/60">Loading email settings…</div>;
  }
  if (error) return <div className="font-mono text-xs text-destructive">Error: {error}</div>;
  if (!cfg) return <></>;

  return (
    <section aria-label="Email notifications" className="mt-8">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
        <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
          Email
        </h2>
      </div>

      <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-4">
        {/* Global enable toggle — mirrors Slack section */}
        <div className="flex items-center justify-between">
          <div>
            <label className={LABEL_CLASS}>Enabled</label>
            <p className="text-xs text-muted-foreground/60 mt-0.5">
              Send investigation results to the recipients below
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={cfg.enabled}
            disabled={togglingGlobal}
            onClick={() => void toggleGlobal(!cfg.enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              cfg.enabled ? "bg-primary" : "bg-muted-foreground/20"
            }`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
              cfg.enabled ? "translate-x-6" : "translate-x-1"
            }`} />
          </button>
        </div>

        {/* Recipients list */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className={LABEL_CLASS}>Recipients</label>
            <Button
              variant="outline"
              onClick={() => onOpenEditor(null)}
              className="font-mono text-xs font-medium h-9 rounded-lg px-3"
            >
              + Add recipient
            </Button>
          </div>

          {cfg.recipients.length === 0 ? (
            <div className="rounded-md border border-border/40 bg-background/40 px-4 py-6 font-mono text-xs text-muted-foreground/60 text-center">
              No recipients configured
            </div>
          ) : (
            <ul className="rounded-md border border-border/40 divide-y divide-border/40 overflow-hidden">
              {cfg.recipients.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-3 px-3 py-2 text-xs bg-background/40 hover:bg-background/60 transition-colors cursor-pointer group"
                  onClick={() => onOpenEditor(r)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") onOpenEditor(r); }}
                  aria-label={`Edit ${r.label ?? r.address}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-foreground truncate">{r.label ?? r.address}</div>
                    {r.label && <div className="font-mono text-muted-foreground/60 truncate">{r.address}</div>}
                  </div>
                  <span className="font-mono text-muted-foreground">{SEVERITY_LABELS[r.minSeverity]}</span>
                  <div className="flex gap-1">
                    {r.allowedSources.map((s) => (
                      <span
                        key={s}
                        className="font-mono px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground text-[10px]"
                      >
                        {SOURCE_LABELS[s]}
                      </span>
                    ))}
                  </div>
                  {r.scope === "stack" && (
                    <span className="font-mono text-[10px] text-primary/70 px-1.5">
                      stack: {activeStackName ?? "this stack"}
                    </span>
                  )}
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={() => void toggleRow(r)}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-primary"
                    aria-label={`Enable ${r.label ?? r.address}`}
                  />
                  <Button
                    variant="outline"
                    onClick={(e) => { e.stopPropagation(); void testSend(r); }}
                    disabled={testingId === r.id}
                    className="font-mono text-xs font-medium h-9 rounded-lg px-4"
                  >
                    {testingId === r.id ? "…" : "Test"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); void deleteRow(r); }}
                    aria-label={`Delete ${r.label ?? r.address}`}
                    className="h-7 px-2 text-destructive/60 hover:text-destructive hover:bg-destructive/8"
                  >
                    <Trash2 size={12} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {testResult && (
          <div className={`font-mono text-xs px-3 py-2 rounded-md ${
            testResult.ok
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-destructive/10 text-destructive"
          }`}>
            Recipient #{testResult.id}: {testResult.msg}
          </div>
        )}
      </div>
    </section>
  );
});

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Button } from "@/components/ui/button";
import { useStackContext } from "../contexts/StackContext";
import { EmailRecipientsSection, type EmailRecipientsSectionHandle, type Recipient } from "./EmailRecipientsSection.js";
import { EmailRecipientEditor } from "./EmailRecipientEditor.js";
import { SlackEditor } from "./SlackEditor.js";
import { ScopeChip } from "./ScopeChip.js";

type FieldSource = "override" | "global" | "config" | "default";
interface FieldWithSource<T> { value: T; source: FieldSource; }
type OnScanCompleteMode = "always" | "hits-only" | "off";

interface SlackView {
  webhookUrl: FieldWithSource<string | null>;
  enabled: FieldWithSource<boolean>;
  onScanComplete: FieldWithSource<OnScanCompleteMode>;
}

interface NotificationsView {
  slack: SlackView;
  email: { enabled: FieldWithSource<boolean> };
}

const LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60";

const SCAN_MODE_LABEL: Record<OnScanCompleteMode, string> = {
  always: "always",
  "hits-only": "hits only",
  off: "off",
};

function maskWebhook(url: string | null): string {
  if (!url) return "Not configured";
  // Slack webhook URLs are like https://hooks.slack.com/services/T.../B.../xxxx
  // Show host + first segment, mask the rest.
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const visible = segments[0] ? `/${segments[0]}/…` : "";
    return `${u.host}${visible}`;
  } catch {
    return url.length > 32 ? `${url.slice(0, 32)}…` : url;
  }
}

type EditorMode = "none" | "slack" | "email";

interface NotificationsTabProps {
  activeStackName?: string;
}

function chipForField<T>(
  field: FieldWithSource<T>,
  onOverride: () => void,
  onUseGlobal: () => void,
): JSX.Element {
  if (field.source === "override") {
    return (
      <ScopeChip
        kind="override"
        actions={[
          { label: "Edit override", onSelect: onOverride },
          { label: "Use global instead", onSelect: onUseGlobal, destructive: true },
        ]}
      />
    );
  }
  return (
    <ScopeChip
      kind="global"
      actions={[{ label: "Override for this stack", onSelect: onOverride }]}
    />
  );
}

export function NotificationsTab({ activeStackName }: NotificationsTabProps = {}) {
  const { activeStackId, stackFetch } = useStackContext();
  const [view, setView] = useState<NotificationsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("none");
  const [editingRecipient, setEditingRecipient] = useState<Recipient | null>(null);
  const recipientsRef = useRef<EmailRecipientsSectionHandle>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await stackFetch("/api/notifications");
      const data = await res.json();
      setView(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [stackFetch]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const toggleSlackEnabled = async () => {
    if (togglingEnabled || !view) return;
    const next = !view.slack.enabled.value;
    setTogglingEnabled(true);
    try {
      const res = await stackFetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slack: { enabled: next } }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to update");
      }
      await fetchConfig();
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setTogglingEnabled(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await stackFetch("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      setTestResult(res.ok ? { ok: true } : { ok: false, error: data.error ?? "Test failed" });
    } catch {
      setTestResult({ ok: false, error: "Network error" });
    }
    setTesting(false);
  };

  const clearOverride = async () => {
    if (!confirm("Revert all per-stack overrides on this tab? This stack will follow the global values for every Notifications field.")) return;
    const res = await stackFetch("/api/notifications/override", { method: "DELETE" });
    if (res.ok) await fetchConfig();
  };

  const overrideEnabled = async () => {
    if (!view) return;
    const res = await stackFetch("/api/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slack: { enabled: view.slack.enabled.value } }),
    });
    if (res.ok) await fetchConfig();
  };

  const overrideOnScanComplete = async () => {
    if (!view) return;
    const res = await stackFetch("/api/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slack: { onScanComplete: view.slack.onScanComplete.value } }),
    });
    if (res.ok) await fetchConfig();
  };

  if (loading || !view) {
    return (
      <div className="h-32 rounded-lg" style={{
        background: "linear-gradient(90deg, hsl(var(--muted)) 25%, hsl(var(--secondary)) 50%, hsl(var(--muted)) 75%)",
        backgroundSize: "200% 100%",
        animation: "shimmer 1.6s infinite",
      }} />
    );
  }

  if (editorMode === "slack") {
    return (
      <SlackEditor
        stackFetch={stackFetch}
        config={{
          webhookUrl: view.slack.webhookUrl.value,
          enabled: view.slack.enabled.value,
          onScanComplete: view.slack.onScanComplete.value,
        }}
        onClose={() => setEditorMode("none")}
        onSaved={() => {
          setEditorMode("none");
          void fetchConfig();
        }}
      />
    );
  }

  if (editorMode === "email") {
    return (
      <EmailRecipientEditor
        stackFetch={stackFetch}
        existing={editingRecipient}
        activeStackName={activeStackName}
        onClose={() => { setEditorMode("none"); setEditingRecipient(null); }}
        onSaved={() => {
          setEditorMode("none");
          setEditingRecipient(null);
          void recipientsRef.current?.refresh();
        }}
      />
    );
  }

  const slack = view.slack;
  const slackConfigured = !!slack.webhookUrl.value;
  const stackDisplay = activeStackName ?? activeStackId;

  return (
    <div>
      {/* Title row */}
      <div className="mb-6 animate-fade-up">
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90">Notifications</h1>
        <p className="text-xs font-mono text-muted-foreground/70 mt-1 tracking-wide">
          Where to send investigation results and scan summaries
        </p>
      </div>

      {/* Effective-settings banner */}
      <div className="mb-5 rounded-lg border border-border/40 bg-card/40 px-4 py-3 flex items-start gap-3 animate-fade-in">
        <span aria-hidden className="text-base mt-0.5">🌐</span>
        <div>
          <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground/80">
            Showing effective settings for: {stackDisplay}
          </div>
          <p className="text-xs text-muted-foreground/70 mt-0.5 max-w-xl">
            Some values are global (apply to all stacks); others are overridden for this stack. Click any chip to override or revert.
          </p>
        </div>
      </div>

      {/* Section: SLACK */}
      <section aria-label="Slack notifications" className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            Slack
          </h2>
          {slack.webhookUrl.source === "config" && (
            <span className="font-mono text-[9px] text-muted-foreground/40 ml-1">(from config.yaml)</span>
          )}
        </div>

        <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className={LABEL_CLASS}>Enabled</label>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                Send investigation results to Slack when complete
              </p>
            </div>
            <div className="flex items-center gap-3">
              {chipForField(slack.enabled, () => void overrideEnabled(), () => void clearOverride())}
              <button
                type="button"
                role="switch"
                aria-checked={slack.enabled.value}
                disabled={togglingEnabled}
                onClick={() => void toggleSlackEnabled()}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  slack.enabled.value ? "bg-primary" : "bg-muted-foreground/20"
                }`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  slack.enabled.value ? "translate-x-6" : "translate-x-1"
                }`} />
              </button>
            </div>
          </div>

          {/* Webhook row — mirrors Email recipients list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={LABEL_CLASS}>Webhook</label>
              <div className="flex items-center gap-3">
                {chipForField(slack.webhookUrl, () => setEditorMode("slack"), () => void clearOverride())}
                <Button
                  variant="outline"
                  onClick={() => setEditorMode("slack")}
                  className="font-mono text-xs font-medium h-9 rounded-lg px-3"
                >
                  {slackConfigured ? "Edit webhook" : "+ Add webhook"}
                </Button>
              </div>
            </div>

            {!slackConfigured ? (
              <div className="rounded-md border border-border/40 bg-background/40 px-4 py-6 font-mono text-xs text-muted-foreground/60 text-center">
                No webhook configured
              </div>
            ) : (
              <ul className="rounded-md border border-border/40 divide-y divide-border/40 overflow-hidden">
                <li
                  className="flex items-center gap-3 px-3 py-2 text-xs bg-background/40 hover:bg-background/60 transition-colors cursor-pointer"
                  onClick={() => setEditorMode("slack")}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") setEditorMode("slack"); }}
                  aria-label="Edit Slack webhook"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-foreground truncate">{maskWebhook(slack.webhookUrl.value)}</div>
                  </div>
                  <span className="font-mono px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground text-[10px]">
                    scan: {SCAN_MODE_LABEL[slack.onScanComplete.value]}
                  </span>
                  <div onClick={(e) => e.stopPropagation()}>
                    {chipForField(
                      slack.onScanComplete,
                      () => void overrideOnScanComplete(),
                      () => void clearOverride(),
                    )}
                  </div>
                  <Button
                    variant="outline"
                    onClick={(e) => { e.stopPropagation(); void handleTest(); }}
                    disabled={testing}
                    className="font-mono text-xs font-medium h-9 rounded-lg px-4"
                  >
                    {testing ? "…" : "Test"}
                  </Button>
                </li>
              </ul>
            )}
          </div>

          {testResult && (
            <div className={`text-xs font-mono px-3 py-2 rounded-md ${
              testResult.ok
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-destructive/10 text-destructive"
            }`}>
              {testResult.ok ? "Test notification sent successfully" : testResult.error}
            </div>
          )}
        </div>
      </section>

      <EmailRecipientsSection
        ref={recipientsRef}
        stackFetch={stackFetch}
        activeStackName={activeStackName}
        onOpenEditor={(r) => { setEditingRecipient(r); setEditorMode("email"); }}
      />
    </div>
  );
}

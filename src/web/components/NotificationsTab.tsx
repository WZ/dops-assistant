import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useStackContext } from "../contexts/StackContext";

interface SlackConfig {
  webhookUrl: string | null;
  enabled: boolean;
  source: "gui" | "config" | "none";
}

const LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60";

const INPUT_CLASS =
  "w-full rounded-md border border-border/40 bg-card/50 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/15";

export function NotificationsTab() {
  const { stackFetch } = useStackContext();
  const [slack, setSlack] = useState<SlackConfig>({ webhookUrl: null, enabled: false, source: "none" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [enabledInput, setEnabledInput] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [dirty, setDirty] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await stackFetch("/api/notifications");
      const data = await res.json();
      setSlack(data.slack);
      setUrlInput(data.slack.webhookUrl ?? "");
      setEnabledInput(data.slack.enabled);
    } catch { /* ignore */ }
    setLoading(false);
  }, [stackFetch]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const handleSave = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const res = await stackFetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slack: {
            webhookUrl: urlInput || null,
            enabled: enabledInput,
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save");
      }
      setDirty(false);
      await fetchConfig();
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "Save failed" });
    }
    setSaving(false);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await stackFetch("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: urlInput || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setTestResult({ ok: true });
      } else {
        setTestResult({ ok: false, error: data.error || "Test failed" });
      }
    } catch {
      setTestResult({ ok: false, error: "Network error" });
    }
    setTesting(false);
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="h-32 rounded-lg" style={{
          background: "linear-gradient(90deg, hsl(var(--muted)) 25%, hsl(var(--secondary)) 50%, hsl(var(--muted)) 75%)",
          backgroundSize: "200% 100%",
          animation: "shimmer 1.6s infinite",
        }} />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Section: SLACK */}
      <section aria-label="Slack notifications" className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-0.5 h-3.5 rounded-full bg-primary/60" />
          <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            Slack
          </h2>
          {slack.source === "config" && (
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
            <button
              type="button"
              role="switch"
              aria-checked={enabledInput}
              onClick={() => { setEnabledInput(!enabledInput); setDirty(true); }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                enabledInput ? "bg-primary" : "bg-muted-foreground/20"
              }`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                enabledInput ? "translate-x-6" : "translate-x-1"
              }`} />
            </button>
          </div>

          {/* Webhook URL */}
          <div>
            <label className={LABEL_CLASS}>Webhook URL</label>
            <div className="relative mt-1">
              <input
                type={showUrl ? "text" : "password"}
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); setDirty(true); }}
                placeholder="https://hooks.slack.com/services/..."
                className={INPUT_CLASS}
              />
              <button
                type="button"
                onClick={() => setShowUrl(!showUrl)}
                className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground/50 hover:text-muted-foreground"
              >
                {showUrl ? "hide" : "show"}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground/40 mt-1 font-mono">
              Create at slack.com → Apps → Incoming Webhooks
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
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testing || !urlInput}
              className="font-mono text-xs font-medium h-9 rounded-lg px-4"
            >
              {testing ? "Sending..." : "Test"}
            </Button>
          </div>

          {/* Test result */}
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

      {/* Future: other notification channels */}
      <div className="text-[10px] font-mono text-muted-foreground/30 mt-4">
        More channels coming soon (PagerDuty, email)
      </div>
    </div>
  );
}

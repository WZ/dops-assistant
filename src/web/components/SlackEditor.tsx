import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

type OnScanCompleteMode = "always" | "hits-only" | "off";

interface SlackConfig {
  webhookUrl: string | null;
  enabled: boolean;
  onScanComplete: OnScanCompleteMode;
}

interface Props {
  stackFetch: (path: string, init?: RequestInit) => Promise<Response>;
  config: SlackConfig;
  onClose: () => void;
  onSaved: () => void;
}

const LABEL_CLASS =
  "block font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60 mb-1.5";
const INPUT_CLASS =
  "w-full h-9 px-3 rounded-lg border border-border/40 bg-background/40 text-xs text-foreground placeholder:text-muted-foreground/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function SlackEditor({ stackFetch, config, onClose, onSaved }: Props) {
  const [urlInput, setUrlInput] = useState(config.webhookUrl ?? "");
  const [onScanComplete, setOnScanComplete] = useState<OnScanCompleteMode>(config.onScanComplete);
  const [showUrl, setShowUrl] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const save = async () => {
    setError(null);
    setTestResult(null);
    setSaving(true);
    try {
      const res = await stackFetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slack: {
            webhookUrl: urlInput || null,
            enabled: config.enabled,
            onScanComplete,
          },
        }),
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

  const test = async () => {
    setTestResult(null);
    setTesting(true);
    try {
      const res = await stackFetch("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: urlInput || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      setTestResult({
        ok: res.ok,
        msg: res.ok ? "Test notification sent successfully" : (data.error ?? `HTTP ${res.status}`),
      });
    } catch {
      setTestResult({ ok: false, msg: "Network error" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden" aria-label="Slack webhook editor">
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
          Slack Webhook
        </h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void test()}
            disabled={testing || !urlInput}
            className="px-3 py-1.5 h-auto text-[10px] font-mono disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {testing ? "Sending…" : "Test"}
          </Button>
          <Button
            variant="outline"
            onClick={() => void save()}
            disabled={saving}
            className="px-3 py-1.5 h-auto text-[10px] font-mono bg-primary/10 border-primary/20 text-primary hover:bg-primary/15 hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          <div>
            <label className={LABEL_CLASS}>Webhook URL</label>
            <div className="relative">
              <input
                type={showUrl ? "text" : "password"}
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
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

          <div>
            <label className={LABEL_CLASS}>Scan run summary</label>
            <div className="flex gap-4 text-xs text-foreground">
              {(["always", "hits-only", "off"] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="slack-scan-run-mode"
                    checked={onScanComplete === mode}
                    onChange={() => setOnScanComplete(mode)}
                    className="accent-primary"
                  />
                  {mode === "always" ? "Always" : mode === "hits-only" ? "Hits only" : "Off"}
                </label>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground/40 mt-1 font-mono">
              When to post a scan run summary to Slack. "Hits only" posts when the scan flagged services.
            </p>
          </div>

          {error && <p className="font-mono text-xs text-destructive">{error}</p>}
          {testResult && (
            <div className={`font-mono text-xs px-3 py-2 rounded-md ${
              testResult.ok
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-destructive/10 text-destructive"
            }`}>
              {testResult.msg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

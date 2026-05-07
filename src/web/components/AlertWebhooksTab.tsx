import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useStackContext } from "../contexts/StackContext";

/**
 * Settings → Alert Webhooks tab.
 *
 * Surface for wiring Grafana / Alertmanager → /api/webhook/alert. Tokens are
 * managed here (not config.yaml). The plaintext token is shown ONCE at
 * creation, then only a masked form is recoverable. Snippets are rendered
 * relative to `window.location.origin` so they work behind any ingress.
 */

interface TokenRow {
  id: string;
  name: string;
  masked: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface InfoResponse {
  url: string;
  defaultUrl: string;
  stackSlug: string;
  tokens: TokenRow[];
  severityTemplateMap: Record<string, string>;
  defaultTemplate: string;
  dedupWindowSeconds: number;
  maxConcurrent: number;
  serviceLabelKeys: string[];
  acceptsResolved: boolean;
}

const LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60";

function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path;
  // Honor APP_BASE so behind-ingress deploys produce the right URL the operator
  // pastes into Grafana.
  const base = (window as unknown as { __APP_BASE__?: string }).__APP_BASE__ ?? "/";
  const trimmedBase = base === "/" ? "" : base.replace(/\/+$/, "");
  return `${window.location.origin}${trimmedBase}${path}`;
}

/** SQLite's `datetime('now')` returns `YYYY-MM-DD HH:MM:SS` in UTC. JS's
 *  `new Date(...)` parses that as local time, off by the local offset.
 *  Coerce to ISO with explicit `Z`. */
function parseUtcDatetime(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return new Date(s.replace(" ", "T") + "Z");
  }
  return new Date(s);
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never used";
  const date = parseUtcDatetime(iso);
  const ms = Date.now() - date.getTime();
  if (Number.isNaN(ms)) return iso;
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="link"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard may be blocked */ }
      }}
      className="font-mono text-[10px] h-auto p-0 text-primary/70 hover:text-primary no-underline hover:no-underline"
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <div className="relative">
      <pre className="font-mono text-[11px] bg-secondary/30 border border-border/50 rounded-md p-3 overflow-x-auto whitespace-pre-wrap">{value}</pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={value} />
      </div>
    </div>
  );
}

export function AlertWebhooksTab() {
  const { stackFetch } = useStackContext();
  const [info, setInfo] = useState<InfoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealedToken, setRevealedToken] = useState<{ name: string; token: string } | null>(null);

  const [testToken, setTestToken] = useState("");
  const [testService, setTestService] = useState("");
  const [testSeverity, setTestSeverity] = useState("warning");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [snippetTokenName, setSnippetTokenName] = useState<string>("");

  const fetchInfo = useCallback(async () => {
    try {
      const res = await stackFetch("/api/webhooks/info");
      if (!res.ok) {
        setError(`Failed to load webhook info: HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as InfoResponse;
      setInfo(data);
      setLoading(false);
      if (!snippetTokenName && data.tokens[0]) {
        setSnippetTokenName(data.tokens[0].name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, [stackFetch, snippetTokenName]);

  useEffect(() => { fetchInfo(); }, [fetchInfo]);

  const fullUrl = useMemo(() => info ? absoluteUrl(info.url) : "", [info]);

  const submitCreate = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await stackFetch("/api/webhooks/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(`Token create failed: ${body.error ?? res.status}`);
        setCreating(false);
        return;
      }
      const created = (await res.json()) as { name: string; token: string };
      setRevealedToken({ name: created.name, token: created.token });
      setCreateOpen(false);
      setNewName("");
      await fetchInfo();
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string, name: string) => {
    if (!window.confirm(`Revoke token "${name}"? Any Grafana contact point still using it will start getting 401s.`)) return;
    const res = await stackFetch(`/api/webhooks/tokens/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(`Revoke failed: HTTP ${res.status}`);
      return;
    }
    await fetchInfo();
  };

  const sendTest = async (mode: "internal" | "loopback") => {
    if (!testToken.trim() || testing) return;
    setTestResult(null);
    setTesting(true);
    try {
      const path = mode === "internal" ? "/api/webhooks/test" : "/api/webhooks/loopback-test";
      const res = await stackFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: testToken.trim(),
          severity: testSeverity,
          ...(testService.trim() ? { service: testService.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const errMsg = typeof body["error"] === "string" ? body["error"] : `HTTP ${res.status}`;
        const hint = typeof body["hint"] === "string" ? ` (${body["hint"]})` : "";
        setTestResult({ ok: false, message: `${errMsg}${hint}` });
      } else if (mode === "internal") {
        const status = typeof body["deliveryStatus"] === "string" ? body["deliveryStatus"] : "unknown";
        const svc = typeof body["service"] === "string" ? body["service"] : "?";
        const started = status === "investigated";
        setTestResult({ ok: started, message: `Test ${status} for service "${svc}"` });
      } else {
        const upstreamStatus = typeof body["status"] === "number" ? body["status"] : 0;
        const upstreamOk = body["ok"] === true;
        const latency = typeof body["latencyMs"] === "number" ? body["latencyMs"] : null;
        setTestResult({
          ok: upstreamOk,
          message: `Loopback ${upstreamOk ? "✓" : "✗"} — upstream HTTP ${upstreamStatus}${latency != null ? ` (${latency}ms)` : ""}`,
        });
      }
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="text-muted-foreground/70 font-mono text-xs py-8">Loading…</div>;
  if (error) return <div className="text-destructive font-mono text-xs py-8">{error}</div>;
  if (!info) return null;

  const tokenForSnippet = info.tokens.find((t) => t.name === snippetTokenName) ?? info.tokens[0];
  const snippetTokenPlaceholder = tokenForSnippet
    ? `<paste-token-named-${tokenForSnippet.name}>`
    : "<generate-a-token-first>";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-lg font-bold tracking-tight text-foreground/90 mb-1">Alert Webhooks</h2>
        <p className="text-xs font-body text-muted-foreground/70 leading-relaxed">
          Wire Grafana, Alertmanager, or any HTTP source to <code className="font-mono text-[11px]">/api/webhook/alert</code> so firing alerts auto-trigger investigations. Tokens are managed below.
        </p>
      </div>

      <section className="space-y-2">
        <div className={LABEL_CLASS}>Endpoint URL</div>
        <CodeBlock value={fullUrl} />
        <p className="text-[11px] font-body text-muted-foreground/60">
          Stack-scoped URL for <code>{info.stackSlug}</code>. Other stacks have their own URLs at{" "}
          <code className="font-mono text-[10px]">/api/webhook/alert/&lt;slug&gt;</code>.
        </p>
      </section>

      <section className="space-y-3 rounded-md border border-border/50 bg-card/30 p-4">
        <div className={LABEL_CLASS}>What alert sources must send</div>
        <div className="space-y-2 text-[11px] font-body text-foreground/80">
          <div>
            <span className="text-muted-foreground/60">Service label keys: </span>
            {info.serviceLabelKeys.map((k) => (
              <code key={k} className="font-mono text-[10px] mx-1">{k}</code>
            ))}
            <span className="text-muted-foreground/60">— at least one must be set or the alert returns 422.</span>
          </div>
          <div>
            <span className="text-muted-foreground/60">Severity → template: </span>
            {Object.entries(info.severityTemplateMap).map(([sev, tpl]) => (
              <code key={sev} className="font-mono text-[10px] mx-1">{sev}→{tpl}</code>
            ))}
            <span className="text-muted-foreground/60"> (default: <code className="font-mono text-[10px]">{info.defaultTemplate}</code>).</span>
          </div>
          <div className="text-muted-foreground/70">
            Dedup window: <code className="font-mono text-[10px]">{info.dedupWindowSeconds}s</code> · Max concurrent: <code className="font-mono text-[10px]">{info.maxConcurrent}</code> · Resolved alerts ignored.
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className={LABEL_CLASS}>Tokens</div>
          <Button
            type="button"
            onClick={() => { setCreateOpen(true); setNewName(""); }}
            className="font-mono text-[10px] h-7 px-3"
          >
            + Generate token
          </Button>
        </div>
        {info.tokens.length === 0 ? (
          <p className="text-[11px] font-body text-muted-foreground/60 italic">
            No tokens yet. Generate one to start receiving alerts.
          </p>
        ) : (
          <div className="space-y-1">
            {info.tokens.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-3 py-2 rounded-md border border-border/40 bg-card/30">
                <span className="font-body text-[12px] font-medium text-foreground/90 flex-1 truncate">{t.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground/60">{t.masked}</span>
                <span
                  className="font-mono text-[10px] text-muted-foreground/40 min-w-[140px] text-right"
                  title={t.lastUsedAt ?? "never used"}
                >
                  {t.lastUsedAt ? `last used ${relativeTime(t.lastUsedAt)}` : "never used"}
                </span>
                <Button
                  type="button"
                  variant="link"
                  onClick={() => revoke(t.id, t.name)}
                  className="font-mono text-[10px] h-auto p-0 text-destructive/70 hover:text-destructive no-underline hover:no-underline"
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] font-body text-muted-foreground/60">
          Rotation: generate a new token, switch Grafana to it, then revoke the old one. Both tokens accept alerts during the overlap — no missed alerts.
        </p>
      </section>

      <section className="space-y-3">
        <div className={LABEL_CLASS}>Snippets</div>
        {info.tokens.length === 0 ? (
          <p className="text-[11px] font-body text-muted-foreground/60 italic">
            Generate a token first; snippets reference it.
          </p>
        ) : (
          <>
            {info.tokens.length > 1 && (
              <select
                value={snippetTokenName}
                onChange={(e) => setSnippetTokenName(e.target.value)}
                className="font-mono text-[10px] bg-secondary/30 border border-border/50 rounded-md px-2 py-1"
              >
                {info.tokens.map((t) => (
                  <option key={t.id} value={t.name}>{t.name}</option>
                ))}
              </select>
            )}

            <div className="space-y-2">
              <div className={`${LABEL_CLASS} mt-2`}>Grafana 10/11 — Contact Point form</div>
              <CodeBlock value={`URL: ${fullUrl}
HTTP Method: POST
Authorization Header: Bearer ${snippetTokenPlaceholder}`} />
            </div>

            <div className="space-y-2">
              <div className={`${LABEL_CLASS} mt-2`}>Prometheus Alertmanager — webhook_configs</div>
              <CodeBlock value={`# Option 1: bearer in a file (recommended for IaC, doesn't leak in your repo)
receivers:
  - name: webhook-receiver
    webhook_configs:
      - url: ${fullUrl}
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/webhook-token  # file contains the raw token

# Option 2: bearer inline (simpler for one-off tests; commit-and-rotate carefully)
receivers:
  - name: webhook-receiver
    webhook_configs:
      - url: ${fullUrl}
        http_config:
          authorization:
            type: Bearer
            credentials: ${snippetTokenPlaceholder}`} />
            </div>

            <div className="space-y-2">
              <div className={`${LABEL_CLASS} mt-2`}>curl — verify the network path</div>
              <CodeBlock value={`curl -X POST ${fullUrl} \\
  -H "Authorization: Bearer ${snippetTokenPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -d '{"alerts":[{"status":"firing","labels":{"alertname":"manual","severity":"warning","service":"my-service"},"annotations":{},"startsAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","endsAt":"0001-01-01T00:00:00Z"}]}'`} />
            </div>
          </>
        )}
      </section>

      <section className="space-y-3 rounded-md border border-border/50 bg-card/30 p-4">
        <div className={LABEL_CLASS}>Send test alert</div>
        <p className="text-[11px] font-body text-muted-foreground/60">
          Two modes. <strong>Internal</strong> synthesizes a payload and runs it through the same handler real traffic hits — validates the app side. <strong>Loopback</strong> dispatches a real outbound HTTP call to your public URL — validates DNS, TLS, ingress, auth end-to-end. Paste a token to authorize either; same trust model as production Grafana.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            placeholder="Paste a webhook token"
            value={testToken}
            onChange={(e) => setTestToken(e.target.value)}
            className="font-mono text-[11px] bg-secondary/30 border border-border/50 rounded-md px-2 py-1.5 sm:col-span-2"
          />
          <input
            type="text"
            placeholder="Service name (optional)"
            value={testService}
            onChange={(e) => setTestService(e.target.value)}
            className="font-mono text-[11px] bg-secondary/30 border border-border/50 rounded-md px-2 py-1.5"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={testSeverity}
            onChange={(e) => setTestSeverity(e.target.value)}
            className="font-mono text-[10px] bg-secondary/30 border border-border/50 rounded-md px-2 py-1"
          >
            {Object.keys(info.severityTemplateMap).map((sev) => (
              <option key={sev} value={sev}>{sev}</option>
            ))}
          </select>
          <Button
            type="button"
            onClick={() => sendTest("internal")}
            disabled={testing || !testToken.trim()}
            className="font-mono text-[10px] h-7 px-3"
          >
            {testing ? "Sending…" : "Send test (internal)"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => sendTest("loopback")}
            disabled={testing || !testToken.trim()}
            className="font-mono text-[10px] h-7 px-3"
          >
            {testing ? "Sending…" : "Send test (loopback)"}
          </Button>
          {testResult && (
            <span className={`font-mono text-[10px] ${testResult.ok ? "text-success" : "text-destructive"}`}>
              {testResult.message}
            </span>
          )}
        </div>
      </section>

      {createOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-md p-5 w-[400px] space-y-3">
            <h3 className="font-display text-base font-bold">Generate webhook token</h3>
            <input
              type="text"
              autoFocus
              placeholder="Token name (e.g. grafana-prod)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="font-mono text-[11px] bg-secondary/30 border border-border/50 rounded-md px-2 py-1.5 w-full"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="link"
                onClick={() => setCreateOpen(false)}
                className="font-mono text-[10px] text-muted-foreground/70 no-underline hover:no-underline"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={submitCreate}
                disabled={creating || !newName.trim()}
                className="font-mono text-[10px]"
              >
                {creating ? "Generating…" : "Generate"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {revealedToken && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-md p-5 w-[520px] space-y-4">
            <h3 className="font-display text-base font-bold">Token created — save it now</h3>
            <p className="text-[11px] font-body text-muted-foreground/80">
              This is the only time you'll see the plaintext token for <code className="font-mono">{revealedToken.name}</code>. Copy it into Grafana, then close this dialog.
            </p>
            <CodeBlock value={revealedToken.token} />
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => setRevealedToken(null)}
                className="font-mono text-[10px]"
              >
                I've saved it
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

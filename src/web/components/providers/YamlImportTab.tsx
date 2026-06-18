import { useState } from "react";
import { parse } from "yaml";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils.js";
import { useStackContext } from "../../contexts/StackContext";
import { Check, AlertTriangle, XCircle } from "lucide-react";

interface DryRunResult {
  name: string;
  status: "ready" | "conflict" | "invalid";
  source?: "config" | "gui";
  error?: string;
}

interface ConfirmResult {
  name: string;
  status: "added" | "overwritten" | "skipped" | "failed";
  toolCount?: number;
  error?: string;
}

type Phase = "paste" | "review" | "done";

// Backstop so the import/validate buttons can never spin forever if the server
// stalls (e.g. probing an unreachable MCP upstream). The server now bounds its
// own per-provider probes, so this only fires in pathological cases.
const IMPORT_TIMEOUT_MS = 45_000;

interface YamlImportTabProps {
  onImported: () => void;
  onCancel: () => void;
}

export function YamlImportTab({ onImported, onCancel }: YamlImportTabProps) {
  const { stackFetch } = useStackContext();
  const [phase, setPhase] = useState<Phase>("paste");
  const [yamlText, setYamlText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);

  // Review phase state
  const [dryRunResults, setDryRunResults] = useState<DryRunResult[]>([]);
  const [parsedProviders, setParsedProviders] = useState<unknown[]>([]);
  const [overwriteSet, setOverwriteSet] = useState<Set<string>>(new Set());

  // Done phase state
  const [confirmResults, setConfirmResults] = useState<ConfirmResult[]>([]);

  const handleValidate = async () => {
    setParseError(null);
    setNetworkError(null);

    // Client-side YAML parse
    let parsed: unknown;
    try {
      parsed = parse(yamlText);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Invalid YAML syntax");
      return;
    }

    // Validate parsed result is a provider object or array of objects
    if (parsed == null || typeof parsed !== "object") {
      setParseError("Expected a provider object or array of providers");
      return;
    }
    const providers = Array.isArray(parsed) ? parsed : [parsed];

    setValidating(true);
    try {
      const res = await stackFetch("/api/providers/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers }),
        signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = await res.json();
        setNetworkError(err.error || "Server error");
        return;
      }
      const data = await res.json();
      setParsedProviders(providers);
      setDryRunResults(data.results);
      setOverwriteSet(new Set());
      setPhase("review");
    } catch (err) {
      setNetworkError(
        err instanceof DOMException && err.name === "TimeoutError"
          ? "Validation timed out. The server may be slow to reach a provider."
          : "Failed to reach server. Check your connection.",
      );
    } finally {
      setValidating(false);
    }
  };

  const handleConfirm = async () => {
    setConfirming(true);
    setNetworkError(null);
    try {
      const res = await stackFetch("/api/providers/import/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providers: parsedProviders,
          overwrite: Array.from(overwriteSet),
        }),
        signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = await res.json();
        setNetworkError(err.error || "Server error");
        return;
      }
      const data = await res.json();
      setConfirmResults(data.results);
      setPhase("done");
      onImported();
    } catch (err) {
      setNetworkError(
        err instanceof DOMException && err.name === "TimeoutError"
          ? "Import timed out. The server may be slow to reach a provider."
          : "Failed to reach server. Check your connection.",
      );
    } finally {
      setConfirming(false);
    }
  };

  const toggleOverwrite = (name: string) => {
    setOverwriteSet((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const hasActionableProviders = dryRunResults.some(
    (r) => r.status === "ready" || (r.status === "conflict" && r.source !== "config" && overwriteSet.has(r.name)),
  );

  // ── PASTE phase ──
  if (phase === "paste") {
    return (
      <div className="space-y-4">
        <textarea
          value={yamlText}
          onChange={(e) => {
            setYamlText(e.target.value);
            if (parseError) setParseError(null);
          }}
          placeholder={`- name: my-grafana\n  roles: [metrics, logs]\n  mcpServer:\n    transport: http\n    url: http://localhost:8000/mcp`}
          className="w-full rounded-md border border-border/40 bg-card/50 px-3 py-2 font-mono text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/15 resize-y"
          rows={14}
          aria-label="Providers YAML"
          spellCheck={false}
        />
        {parseError && (
          <p className="text-xs text-destructive/80">{parseError}</p>
        )}
        {networkError && (
          <p className="text-xs text-destructive/80">{networkError}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
            className="text-[10px] font-mono text-muted-foreground/70 hover:text-foreground h-auto py-3 px-2 min-h-[44px]"
          >
            Cancel
          </Button>
          <Button
            onClick={handleValidate}
            disabled={!yamlText.trim() || validating}
            className="font-mono text-xs font-medium min-h-[44px]"
          >
            {validating ? "Validating..." : "Validate & Import"}
          </Button>
        </div>
      </div>
    );
  }

  // ── REVIEW phase ──
  if (phase === "review") {
    return (
      <div className="space-y-4">
        <div className="space-y-2 max-h-[350px] overflow-y-auto">
          {dryRunResults.map((r, i) => (
            <div
              key={`${r.name}-${i}`}
              className="flex items-center gap-3 rounded-md border border-border/30 bg-card/30 px-3 py-2"
            >
              {/* Status icon */}
              {r.status === "ready" && <Check size={14} className="text-success shrink-0" />}
              {r.status === "conflict" && <AlertTriangle size={14} className="text-warning shrink-0" />}
              {r.status === "invalid" && <XCircle size={14} className="text-destructive shrink-0" />}

              {/* Name + info */}
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs text-foreground truncate">{r.name}</p>
                {r.status === "conflict" && (
                  <p className="text-[10px] text-muted-foreground/70">
                    already exists ({r.source})
                  </p>
                )}
                {r.status === "invalid" && (
                  <p className="text-[10px] text-destructive/70">{r.error}</p>
                )}
              </div>

              {/* Conflict actions */}
              {r.status === "conflict" && (
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => overwriteSet.has(r.name) && toggleOverwrite(r.name)}
                    className={cn(
                      "font-mono text-[10px] px-2 py-1 rounded",
                      !overwriteSet.has(r.name)
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground/50 hover:text-muted-foreground",
                    )}
                  >
                    Skip
                  </button>
                  <button
                    onClick={() => !overwriteSet.has(r.name) && toggleOverwrite(r.name)}
                    disabled={r.source === "config"}
                    className={cn(
                      "font-mono text-[10px] px-2 py-1 rounded",
                      r.source === "config" && "opacity-40 cursor-not-allowed",
                      overwriteSet.has(r.name)
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground/50 hover:text-muted-foreground",
                    )}
                  >
                    Overwrite
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        {networkError && (
          <p className="text-xs text-destructive/80">{networkError}</p>
        )}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setPhase("paste")}
            className="font-mono text-[10px] text-primary/70 hover:text-primary"
          >
            &larr; Back
          </button>
          <Button
            onClick={handleConfirm}
            disabled={!hasActionableProviders || confirming}
            className="font-mono text-xs font-medium min-h-[44px]"
          >
            {confirming ? "Importing..." : "Confirm Import"}
          </Button>
        </div>
      </div>
    );
  }

  // ── DONE phase ──
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {confirmResults.map((r, i) => (
          <div
            key={`${r.name}-${i}`}
            className="flex items-center gap-3 rounded-md border border-border/30 bg-card/30 px-3 py-2"
          >
            {(r.status === "added" || r.status === "overwritten") && (
              <Check size={14} className="text-success shrink-0" />
            )}
            {r.status === "skipped" && (
              <AlertTriangle size={14} className="text-muted-foreground shrink-0" />
            )}
            {r.status === "failed" && (
              <XCircle size={14} className="text-destructive shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="font-mono text-xs text-foreground truncate">{r.name}</p>
              <p className="text-[10px] text-muted-foreground/70">
                {r.status}{r.toolCount !== undefined ? ` — ${r.toolCount} tools` : ""}
                {r.error ? ` — ${r.error}` : ""}
              </p>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground/70 font-mono">
        {confirmResults.filter((r) => r.status === "added").length} added
        {confirmResults.some((r) => r.status === "overwritten") &&
          `, ${confirmResults.filter((r) => r.status === "overwritten").length} overwritten`}
        {confirmResults.some((r) => r.status === "skipped") &&
          `, ${confirmResults.filter((r) => r.status === "skipped").length} skipped`}
        {confirmResults.some((r) => r.status === "failed") &&
          `, ${confirmResults.filter((r) => r.status === "failed").length} failed`}
      </p>
      <div className="flex justify-end">
        <Button
          onClick={onCancel}
          className="font-mono text-xs font-medium min-h-[44px]"
        >
          Done
        </Button>
      </div>
    </div>
  );
}

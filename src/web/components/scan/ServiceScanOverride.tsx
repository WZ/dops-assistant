// src/web/components/scan/ServiceScanOverride.tsx
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useStackContext } from "../../contexts/StackContext";
import { RuleList } from "./RuleList";
import type { RuleDraft } from "./types";

/**
 * ServiceScanOverride — per-service scan override editor. Renders inside
 * ServiceDetail's "Scan" tab. Three mutually-exclusive modes:
 *
 *   Use global: no override stored. Service uses scan.probe.metrics globally.
 *   Disabled:   {disabled: true}. Service is skipped entirely (no probe, no fire).
 *   Custom:     {rules: [...]}. Service runs THESE rules instead of globals.
 *
 * Switching modes is explicit — a dropdown with three options. We don't
 * let operators compose (both disabled+rules) because the server would
 * prefer disabled and silently ignore rules; explicit is safer.
 */

type OverrideMode = "global" | "disabled" | "custom";

interface OverridePayload {
  disabled?: boolean;
  rules?: RuleDraft[];
}

interface ValidationDetail {
  path: string;
  message: string;
}

interface Props {
  serviceName: string;
}

function modeFromPayload(o: OverridePayload | null): OverrideMode {
  if (!o) return "global";
  if (o.disabled) return "disabled";
  if (o.rules) return "custom";
  return "global";
}

const LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60";

export function ServiceScanOverride({ serviceName }: Props) {
  const { stackFetch } = useStackContext();
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<OverridePayload | null>(null);

  const [mode, setMode] = useState<OverrideMode>("global");
  const [customRules, setCustomRules] = useState<RuleDraft[]>([]);
  const [dirty, setDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ruleErrors, setRuleErrors] = useState<ValidationDetail[]>([]);

  const fetchOverride = useCallback(async () => {
    try {
      const res = await stackFetch(`/api/services/${encodeURIComponent(serviceName)}/scan-override`);
      const data = (await res.json()) as { override: OverridePayload | null };
      setSaved(data.override);
      setMode(modeFromPayload(data.override));
      setCustomRules(data.override?.rules ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [stackFetch, serviceName]);

  useEffect(() => { fetchOverride(); }, [fetchOverride]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setRuleErrors([]);
    try {
      // "global" means clear the override via DELETE (the only path that
      // actually removes the row-level column value, cleanly).
      if (mode === "global") {
        if (saved === null) {
          // Nothing to save — already global. Reset dirty and bail.
          setDirty(false);
          return;
        }
        const res = await stackFetch(
          `/api/services/${encodeURIComponent(serviceName)}/scan-override`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      } else {
        const body: OverridePayload = mode === "disabled"
          ? { disabled: true }
          : { rules: customRules };
        const res = await stackFetch(
          `/api/services/${encodeURIComponent(serviceName)}/scan-override`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string; details?: ValidationDetail[] };
          if (Array.isArray(err.details) && err.details.length > 0 && typeof err.details[0] === "object") {
            setRuleErrors(err.details);
            throw new Error(err.error || "Validation failed");
          }
          throw new Error(err.error || `Save failed: ${res.status}`);
        }
      }
      setDirty(false);
      await fetchOverride();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="p-4">
        <div className="h-24 rounded-lg bg-muted/30 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h3 className="font-display text-sm font-semibold text-foreground/90 mb-1">Per-service scan override</h3>
        <p className="text-xs text-muted-foreground/70">
          Override the global probe rules for <span className="font-mono text-foreground/80">{serviceName}</span>.
          The scan cadence + global concurrency still apply.
        </p>
      </div>

      <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-4">
        <div>
          <label className={LABEL_CLASS}>Mode</label>
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as OverrideMode);
              setDirty(true);
            }}
            className="w-full mt-1 rounded-md border border-border/40 bg-card/50 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/15"
          >
            <option value="global">Use global rules (default)</option>
            <option value="disabled">Skip this service entirely</option>
            <option value="custom">Custom rules for this service</option>
          </select>
          <p className="text-[10px] text-muted-foreground/40 mt-1 font-mono">
            {mode === "global" && "Matches every other service. Clears any existing override."}
            {mode === "disabled" && "No probe queries fire; investigations never dispatch."}
            {mode === "custom" && "These rules replace the global set for this service only."}
          </p>
        </div>

        {mode === "custom" && (
          <div>
            <label className={LABEL_CLASS}>Custom rules</label>
            <div className="mt-2">
              <RuleList
                rules={customRules}
                onChange={(next) => {
                  setCustomRules(next);
                  setDirty(true);
                }}
              />
            </div>
            {ruleErrors.length > 0 && (
              <div className="mt-3 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 space-y-1">
                <div className="text-[11px] font-mono font-semibold text-destructive">
                  {ruleErrors.length === 1 ? "1 rule error:" : `${ruleErrors.length} rule errors:`}
                </div>
                {ruleErrors.map((e, i) => (
                  <div key={i} className="text-[11px] font-mono text-destructive/90">
                    <span className="opacity-70">{e.path}:</span> {e.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2 border-t border-border/30">
          <Button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="font-mono text-xs font-medium h-9 rounded-lg px-4"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          {saveError && (
            <span className="text-[11px] font-mono text-destructive">{saveError}</span>
          )}
        </div>
      </div>
    </div>
  );
}

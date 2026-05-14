import { useCallback, useEffect, useState } from "react";
import { withBase } from "../lib/createStackFetch";
import type { StackSummary } from "../../types/stack-types.js";

type Effort = "low" | "medium" | "high";
type Bucket = "chat" | "investigation" | "discovery";
type Source = "stack" | "config" | "default" | null;

interface BucketEffective {
  effort: Effort | undefined;
  source: Source;
}

interface StackLlmView {
  effective: Record<Bucket, BucketEffective>;
  stack: Partial<Record<Bucket, Effort>>;
  config: {
    default?: Effort;
    chat?: Effort;
    investigation?: Effort;
    discovery?: Effort;
  };
}

interface LlmTabProps {
  /** The currently-active stack. Settings target this stack only — switch the
   *  stack from the header switcher to tune a different one. */
  stack: StackSummary | undefined;
}

const BUCKETS: { key: Bucket; label: string; hint: string }[] = [
  { key: "chat", label: "Chat", hint: "Interactive chat agent + intent classifier" },
  { key: "investigation", label: "Investigation", hint: "Planner, metrics, logs, infra, synthesis" },
  { key: "discovery", label: "Discovery", hint: "AI service discovery + validator" },
];

const SELECT_CLASS =
  "font-mono text-[11px] bg-secondary/30 border border-border/50 rounded-md px-2 py-1.5 min-w-[160px]";

function inheritedFor(view: StackLlmView, bucket: Bucket): Effort | undefined {
  return view.config[bucket] ?? view.config.default;
}

export function LlmTab({ stack }: LlmTabProps) {
  const [view, setView] = useState<StackLlmView | null>(null);
  const [savingKey, setSavingKey] = useState<Bucket | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stackId = stack?.id;

  const fetchOne = useCallback(async () => {
    if (!stackId) {
      setView(null);
      return;
    }
    try {
      const res = await fetch(withBase(`/api/stacks/${stackId}/llm/settings`));
      if (!res.ok) {
        setError(`Failed to load settings: HTTP ${res.status}`);
        return;
      }
      setView((await res.json()) as StackLlmView);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings");
    }
  }, [stackId]);

  useEffect(() => {
    void fetchOne();
  }, [fetchOne]);

  const updateBucket = useCallback(
    async (bucket: Bucket, value: Effort | null) => {
      if (!stackId) return;
      setSavingKey(bucket);
      setError(null);
      try {
        const res = await fetch(withBase(`/api/stacks/${stackId}/llm/settings`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [bucket]: value }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        setView((await res.json()) as StackLlmView);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update");
      } finally {
        setSavingKey(null);
      }
    },
    [stackId],
  );

  if (!stack) {
    return (
      <div className="font-body text-[12px] text-muted-foreground/60 italic">
        No active stack selected.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-base font-semibold tracking-tight text-foreground/90">
          Reasoning effort
        </h2>
        <p className="font-body text-[12px] text-muted-foreground/70 mt-1">
          Per-stack override for the upstream model's{" "}
          <code className="font-mono text-[11px]">reasoning_effort</code> parameter, applied to
          the <strong>active stack only</strong>. Switch stacks from the header to tune another.
          Inherits from <code className="font-mono text-[11px]">config.llm.reasoningEffort</code>{" "}
          when set to "Inherit". Higher effort = slower + more thorough; lower = faster + cheaper.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
          {error}
        </div>
      )}

      <div
        className="rounded-lg border border-border/50 bg-card/40 p-4 space-y-3"
        data-testid={`llm-stack-card-${stack.slug}`}
      >
        <div className="flex items-baseline justify-between">
          <div>
            <div className="font-display text-[14px] font-semibold text-foreground/90">
              {stack.name}
              {stack.isDefault && (
                <span className="ml-2 font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
                  default
                </span>
              )}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground/60">{stack.slug}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {BUCKETS.map(({ key, label, hint }) => {
            const stackValue = view?.stack[key];
            const inherited = view ? inheritedFor(view, key) : undefined;
            const effective = view?.effective[key];
            const saving = savingKey === key;
            return (
              <label key={key} className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/80">
                  {label}
                </span>
                <select
                  className={SELECT_CLASS}
                  disabled={saving || !view}
                  value={stackValue ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    void updateBucket(key, v === "" ? null : (v as Effort));
                  }}
                  data-testid={`llm-select-${stack.slug}-${key}`}
                >
                  <option value="">Inherit{inherited ? ` (${inherited})` : " (unset)"}</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
                <span className="font-body text-[10px] text-muted-foreground/60">{hint}</span>
                {effective?.effort && (
                  <span className="font-mono text-[10px] text-muted-foreground/50">
                    effective: {effective.effort}
                    {effective.source && effective.source !== "stack" && ` · from ${effective.source}`}
                  </span>
                )}
                {!effective?.effort && view && (
                  <span className="font-mono text-[10px] text-muted-foreground/50">
                    effective: (param omitted)
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

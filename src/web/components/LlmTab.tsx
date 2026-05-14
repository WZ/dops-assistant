import { useCallback, useEffect, useState } from "react";
import { useStackContext } from "../contexts/StackContext";
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

/**
 * What the upstream model uses when `reasoning_effort` is omitted from the
 * request. OpenAI's Harmony format (gpt-oss models, plus most OpenAI-compatible
 * gateways exposing reasoning controls) documents the default as `medium`.
 * We surface it in the UI so "Inherit (unset)" reads as a concrete level
 * instead of a mystery.
 *
 * If you switch to a model whose unspecified default isn't `medium`, update
 * this and the "from upstream default" label.
 */
const UPSTREAM_DEFAULT_EFFORT: Effort = "medium";

function inheritedFor(view: StackLlmView, bucket: Bucket): Effort | undefined {
  return view.config[bucket] ?? view.config.default;
}

export function LlmTab({ stack }: LlmTabProps) {
  const { stackFetch } = useStackContext();
  const [view, setView] = useState<StackLlmView | null>(null);
  // Track in-flight buckets as a Set so two concurrent saves on different
  // dropdowns don't fight over a single `savingKey` slot.
  const [savingKeys, setSavingKeys] = useState<Set<Bucket>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const stackId = stack?.id;

  useEffect(() => {
    if (!stackId) {
      setView(null);
      return;
    }
    // AbortController on the effect cleanup: when the operator switches stacks
    // mid-fetch, abort the in-flight request so its delayed response doesn't
    // overwrite the new stack's view (A→B→A switching could otherwise paint
    // B's data on A).
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await stackFetch(`/api/stacks/${stackId}/llm/settings`, { signal: ctrl.signal });
        if (!res.ok) {
          setError(`Failed to load settings: HTTP ${res.status}`);
          return;
        }
        setView((await res.json()) as StackLlmView);
        setError(null);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load settings");
      }
    })();
    return () => ctrl.abort();
  }, [stackId, stackFetch]);

  const updateBucket = useCallback(
    async (bucket: Bucket, value: Effort | null) => {
      if (!stackId) return;
      setSavingKeys((prev) => {
        const next = new Set(prev);
        next.add(bucket);
        return next;
      });
      setError(null);
      try {
        const res = await stackFetch(`/api/stacks/${stackId}/llm/settings`, {
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
        setSavingKeys((prev) => {
          const next = new Set(prev);
          next.delete(bucket);
          return next;
        });
      }
    },
    [stackId, stackFetch],
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
          "Inherit" falls back to{" "}
          <code className="font-mono text-[11px]">config.llm.reasoningEffort</code>; when nothing
          is set there either, the parameter is omitted and the upstream model uses its built-in
          default ({UPSTREAM_DEFAULT_EFFORT} on gpt-oss / OpenAI Harmony). Higher effort = slower
          + more thorough; lower = faster + cheaper.
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
            const saving = savingKeys.has(key);
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
                  <option value="">
                    Inherit ({inherited ?? `${UPSTREAM_DEFAULT_EFFORT} · upstream`})
                  </option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
                <span className="font-body text-[10px] text-muted-foreground/60">{hint}</span>
                {effective?.effort ? (
                  <span className="font-mono text-[10px] text-muted-foreground/50">
                    effective: {effective.effort}
                    {effective.source && effective.source !== "stack" && ` · from ${effective.source}`}
                  </span>
                ) : view ? (
                  <span className="font-mono text-[10px] text-muted-foreground/50">
                    effective: {UPSTREAM_DEFAULT_EFFORT} · upstream default (param omitted)
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

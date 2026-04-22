// src/web/components/scan/RuleEditor.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useStackContext } from "../../contexts/StackContext";
import { RuleTestResult } from "./RuleTestResult";
import type { RuleDraft, RuleTestError, RuleTestResponse, ThresholdOp } from "./types";

/**
 * Per-rule editor row. Exposes all four fields (name, query, op, value,
 * consecutiveTicks) as inputs + a Test button that hits
 * POST /api/scan/rules/test with the rule against a live service. The
 * result renders inline below the row.
 *
 * Rule ordering doesn't matter for execution (probe runs in parallel) but
 * operators like explicit order, so the list provides Up/Down buttons.
 * Remove button is destructive; confirmation is handled via the browser-
 * native confirm() to avoid inventing a custom dialog for a Settings tab.
 */
const LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60";
const INPUT_CLASS =
  "w-full rounded-md border border-border/40 bg-card/50 px-2.5 py-1.5 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/15";

interface Props {
  rule: RuleDraft;
  index: number;
  totalCount: number;
  onChange: (next: RuleDraft) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

export function RuleEditor({ rule, index, totalCount, onChange, onRemove, onMoveUp, onMoveDown }: Props) {
  const { stackFetch } = useStackContext();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<RuleTestResponse | RuleTestError | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await stackFetch("/api/scan/rules/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: rule.query,
          threshold: rule.threshold,
        }),
      });
      const data = (await res.json().catch(() => ({ error: "Invalid response" }))) as RuleTestResponse | RuleTestError;
      setTestResult(data);
    } catch (err) {
      setTestResult({ error: err instanceof Error ? err.message : "Test failed" });
    }
    setTesting(false);
  };

  const handleRemove = () => {
    const name = rule.name || `rule ${index + 1}`;
    if (window.confirm(`Remove rule "${name}"? This clears any hysteresis state it accumulated.`)) {
      onRemove();
    }
  };

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-3 space-y-3">
      {/* Header row: name + reorder/remove */}
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <label className={LABEL_CLASS}>Name</label>
          <input
            type="text"
            value={rule.name}
            onChange={(e) => onChange({ ...rule, name: e.target.value })}
            placeholder="e.g. availability"
            className={`${INPUT_CLASS} mt-1`}
            spellCheck={false}
            data-testid={`rule-name-${index}`}
          />
        </div>
        <div className="flex flex-col gap-1 pt-5">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            className="px-2 py-0.5 text-[10px] font-mono rounded border border-border/40 disabled:opacity-30 hover:bg-secondary/40"
            aria-label="Move rule up"
            title="Move up"
          >
            &uarr;
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === totalCount - 1}
            className="px-2 py-0.5 text-[10px] font-mono rounded border border-border/40 disabled:opacity-30 hover:bg-secondary/40"
            aria-label="Move rule down"
            title="Move down"
          >
            &darr;
          </button>
        </div>
        <button
          type="button"
          onClick={handleRemove}
          className="mt-5 px-2.5 py-1 text-[10px] font-mono rounded border border-destructive/30 text-destructive/80 hover:bg-destructive/10"
          title="Remove rule"
        >
          remove
        </button>
      </div>

      {/* PromQL query */}
      <div>
        <label className={LABEL_CLASS}>Query</label>
        <textarea
          value={rule.query}
          onChange={(e) => onChange({ ...rule, query: e.target.value })}
          placeholder='up{service="{service}"}'
          className={`${INPUT_CLASS} mt-1 min-h-[52px] resize-y`}
          spellCheck={false}
          data-testid={`rule-query-${index}`}
        />
        <p className="text-[10px] text-muted-foreground/40 mt-1 font-mono">
          Must include <code className="text-foreground/70">{"{service}"}</code>. Probe substitutes the service name per query.
        </p>
      </div>

      {/* Threshold + consecutiveTicks */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={LABEL_CLASS}>Op</label>
          <select
            value={rule.threshold.op}
            onChange={(e) => onChange({ ...rule, threshold: { ...rule.threshold, op: e.target.value as ThresholdOp } })}
            className={`${INPUT_CLASS} mt-1`}
            data-testid={`rule-op-${index}`}
          >
            <option value="gt">&gt; (greater than)</option>
            <option value="gte">&ge; (greater or equal)</option>
            <option value="lt">&lt; (less than)</option>
            <option value="lte">&le; (less or equal)</option>
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Threshold</label>
          <input
            type="number"
            value={rule.threshold.value}
            onChange={(e) => onChange({ ...rule, threshold: { ...rule.threshold, value: Number(e.target.value) } })}
            className={`${INPUT_CLASS} mt-1`}
            step="any"
            data-testid={`rule-value-${index}`}
          />
        </div>
        <div>
          <label className={LABEL_CLASS}>Consecutive ticks</label>
          <input
            type="number"
            value={rule.consecutiveTicks}
            onChange={(e) => onChange({ ...rule, consecutiveTicks: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
            className={`${INPUT_CLASS} mt-1`}
            min={1}
            step={1}
            data-testid={`rule-ticks-${index}`}
          />
          <p className="text-[10px] text-muted-foreground/40 mt-1 font-mono">
            N in a row before firing. Defaults to 1 (no hysteresis).
          </p>
        </div>
      </div>

      {/* Test button + result */}
      <div className="pt-1 border-t border-border/30 space-y-2">
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={testing || !rule.query.includes("{service}")}
          className="font-mono text-xs font-medium h-8 rounded-lg px-3"
          title={!rule.query.includes("{service}") ? "Add {service} placeholder to enable testing" : "Run this rule against a live service"}
        >
          {testing ? "Testing..." : "Test rule"}
        </Button>
        <RuleTestResult result={testResult} />
      </div>
    </div>
  );
}

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
    if (window.confirm(`Remove rule "${name}"? Its running count of consecutive triggers will reset.`)) {
      onRemove();
    }
  };

  const iconBtn =
    "h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors";

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-3 space-y-3">
      {/* Header row: name input fills the row; actions sit in a compact strip on the right */}
      <div className="flex items-end gap-2">
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
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            className={iconBtn}
            aria-label="Move rule up"
            title="Move up"
          >
            &uarr;
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === totalCount - 1}
            className={iconBtn}
            aria-label="Move rule down"
            title="Move down"
          >
            &darr;
          </button>
          <button
            type="button"
            onClick={handleRemove}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-colors"
            aria-label="Remove rule"
            title="Remove rule"
          >
            &times;
          </button>
        </div>
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
        <p className="text-[11px] text-muted-foreground/50 mt-1">
          Must include <code className="font-mono text-foreground/70">{"{service}"}</code>. Each service's name is substituted in before the query runs.
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
          <label className={LABEL_CLASS}>Scans in a row</label>
          <input
            type="number"
            value={rule.consecutiveTicks}
            onChange={(e) => onChange({ ...rule, consecutiveTicks: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
            className={`${INPUT_CLASS} mt-1`}
            min={1}
            step={1}
            data-testid={`rule-ticks-${index}`}
          />
        </div>
      </div>

      {/* Test button + result */}
      <div className="pt-1 border-t border-border/30 space-y-2">
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={testing || !rule.query.includes("{service}")}
          className="font-mono text-xs font-medium h-9 rounded-lg px-4"
          title={!rule.query.includes("{service}") ? "Add {service} placeholder to enable testing" : "Run this rule against a live service"}
        >
          {testing ? "Testing..." : "Test rule"}
        </Button>
        <RuleTestResult result={testResult} />
      </div>
    </div>
  );
}

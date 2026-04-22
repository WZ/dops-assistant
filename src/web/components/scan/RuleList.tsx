// src/web/components/scan/RuleList.tsx
import { Button } from "@/components/ui/button";
import { RuleEditor } from "./RuleEditor";
import { DEFAULT_RULE, type RuleDraft } from "./types";

/**
 * Editable list of probe rules. Pure controlled component — parent owns the
 * array state and handles save/discard. Provides add / remove / reorder.
 *
 * Validation is intentionally NOT done here beyond basics (name present) —
 * the server-side validator gives richer per-field errors after save, and
 * duplicating rules here would drift over time.
 */
interface Props {
  rules: RuleDraft[];
  onChange: (next: RuleDraft[]) => void;
}

export function RuleList({ rules, onChange }: Props) {
  const handleRuleChange = (i: number, next: RuleDraft) => {
    const copy = [...rules];
    copy[i] = next;
    onChange(copy);
  };

  const handleRemove = (i: number) => {
    onChange(rules.filter((_, idx) => idx !== i));
  };

  const handleAdd = () => {
    // Suggest a unique default name so operators don't have to rename
    // "availability" to "availability-2" manually. Cheap counter scan.
    const base = "availability";
    let name = base;
    let suffix = 2;
    const existingNames = new Set(rules.map((r) => r.name));
    while (existingNames.has(name)) {
      name = `${base}-${suffix++}`;
    }
    onChange([...rules, { ...DEFAULT_RULE, name }]);
  };

  const handleMove = (from: number, to: number) => {
    if (to < 0 || to >= rules.length) return;
    const copy = [...rules];
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item!);
    onChange(copy);
  };

  if (rules.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 bg-card/30 p-6 text-center space-y-3">
        <p className="text-xs text-muted-foreground/60 font-mono">
          No probe rules. The scan will never fire until you add at least one.
        </p>
        <Button
          variant="outline"
          onClick={handleAdd}
          className="font-mono text-xs font-medium h-9 rounded-lg px-4"
        >
          + Add first rule
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rules.map((rule, i) => (
        <RuleEditor
          key={i}
          rule={rule}
          index={i}
          totalCount={rules.length}
          onChange={(next) => handleRuleChange(i, next)}
          onRemove={() => handleRemove(i)}
          onMoveUp={() => handleMove(i, i - 1)}
          onMoveDown={() => handleMove(i, i + 1)}
        />
      ))}
      <Button
        variant="outline"
        onClick={handleAdd}
        className="font-mono text-xs font-medium h-9 rounded-lg px-4"
      >
        + Add rule
      </Button>
    </div>
  );
}

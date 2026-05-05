import { useState } from "react";
import { ChevronDown, Globe, Bookmark } from "lucide-react";

export type ChipKind = "global" | "override" | "stack";

export interface ScopeChipAction {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

interface Props {
  kind: ChipKind;
  /** For "stack" kind on recipient rows, optionally show the stack name. */
  stackLabel?: string;
  actions?: ScopeChipAction[];
  className?: string;
}

const STYLES: Record<ChipKind, string> = {
  global:   "bg-secondary/40 text-muted-foreground/80 border-border/40",
  override: "bg-primary/10 text-primary border-primary/20",
  stack:    "bg-primary/10 text-primary border-primary/20",
};

export function ScopeChip({ kind, stackLabel, actions, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const interactive = (actions?.length ?? 0) > 0;
  const Icon = kind === "global" ? Globe : Bookmark;
  const label =
    kind === "global"   ? "Global" :
    kind === "override" ? "Override" :
                          (stackLabel ? `stack: ${stackLabel}` : "Stack");

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={() => interactive && setOpen((v) => !v)}
        disabled={!interactive}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded border ${STYLES[kind]} ${interactive ? "hover:opacity-80" : "cursor-default"}`}
      >
        <Icon size={10} className="!size-auto" aria-hidden />
        <span>{label}</span>
        {interactive && <ChevronDown size={10} className="!size-auto" aria-hidden />}
      </button>
      {open && actions && (
        <div className="absolute right-0 top-full mt-1 w-48 rounded-md border border-border/50 bg-card shadow-lg z-20 py-1">
          {actions.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={() => { a.onSelect(); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 text-xs font-mono ${a.destructive ? "text-destructive hover:bg-destructive/10" : "text-foreground/80 hover:bg-secondary/50"}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

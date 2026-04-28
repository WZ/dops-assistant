import type { ReactNode } from "react";

/**
 * Shared filter-row primitives used by Services, Investigations, Patterns,
 * Events, and Scans. Each filter section is a `<FilterGroup label="...">`
 * holding `<Chip>` toggles or native form controls (selects, search inputs).
 *
 * The pattern is intentionally minimal — labels sit inline with their
 * controls, and the whole bar wraps as a `flex flex-wrap`. Wider control
 * shapes (a search input, a sort select) live in their own FilterGroup so
 * they pick up the same label treatment.
 */
export function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
        {label}
      </span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

export function Chip({
  active,
  onClick,
  children,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  tone?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`font-mono text-[10px] uppercase tracking-[0.12em] px-2 h-7 rounded-md border transition-colors ${
        active
          ? "border-primary/60 bg-primary/10 text-primary"
          : `border-border/40 ${tone ?? "text-foreground/70"} hover:bg-card/70 hover:text-foreground`
      }`}
    >
      {children}
    </button>
  );
}

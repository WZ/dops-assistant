import type { ReactNode } from "react";

interface OpsDeskSectionHeaderProps {
  /** Uppercase label, e.g. "Investigation Log". */
  title: string;
  /** Number of rows actually rendered below (the snippet cap, usually 5). */
  count: number;
  /**
   * Total available across the whole stack, if known. When `total > count`
   * the header shows either a "View all N →" link (if `onViewAll` is set) or
   * a plain "N of M" count hint.
   */
  total?: number;
  /** If provided, the "View all N →" link fires this on click. */
  onViewAll?: () => void;
  /** Right-aligned action node (e.g. the "Scan now" button). */
  action?: ReactNode;
}

/**
 * Single source of truth for the three list-section headers on the Operations
 * Desk (Investigation Log, Recent Scans, Recent Events). They all used to
 * render slightly-different markup — different bar heights, different heading
 * colors, different count styling — which made the page read as three
 * unrelated widgets instead of one cohesive scan-column.
 *
 * The count rule:
 *   total === undefined           → show just `count`         ("5")
 *   total > count, no onViewAll   → show "count of total"     ("5 of 32")
 *   total > count, onViewAll set  → show "count" + View-all   ("5" + → link)
 *   total === count               → show just `count`         ("5")
 */
export function OpsDeskSectionHeader({
  title,
  count,
  total,
  onViewAll,
  action,
}: OpsDeskSectionHeaderProps) {
  const hasMore = total !== undefined && total > count;
  const showViewAll = hasMore && onViewAll != null;
  const showOfHint = hasMore && !onViewAll;

  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="w-0.5 h-4 rounded-full bg-primary" aria-hidden />
      <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/50">
        {title}
      </h2>
      <span className="font-mono text-[9px] tabular-nums text-muted-foreground/40">
        {showOfHint ? `${count.toLocaleString()} of ${total!.toLocaleString()}` : count.toLocaleString()}
      </span>
      {(action || showViewAll) && (
        <div className="ml-auto flex items-center gap-3">
          {showViewAll && (
            <button
              type="button"
              onClick={onViewAll}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-primary/80 hover:text-primary transition-colors"
            >
              View all {total!.toLocaleString()} →
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

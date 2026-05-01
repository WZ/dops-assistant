import { useCallback, useEffect, useState } from "react";
import { safeGetItem, safeSetItem } from "../lib/utils";

const STORAGE_KEY = "dops:viewed-investigations";
const STORAGE_EVENT = "dops:viewed-investigations:change";
const MAX_TRACKED = 500;

/**
 * Tracks which investigation IDs the user has already opened so the UI can
 * surface unread completions (RCA cards in chat, rows in the Operations Desk
 * Investigation Log) without relying on an ephemeral floating toast.
 *
 * State is persisted in localStorage and synchronized across hook instances
 * via a custom DOM event so a click in one component immediately clears the
 * NEW indicator in another component using the same hook.
 */
function loadFromStorage(): Set<string> {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function persist(set: Set<string>): void {
  // Cap the persisted set so it can't grow unbounded across long-lived
  // sessions. A FIFO trim is fine — the dropped IDs are old investigations
  // the user has already viewed; the worst case is they re-render a NEW
  // badge once for an investigation they opened months ago.
  const ids = [...set];
  const trimmed = ids.length > MAX_TRACKED ? ids.slice(ids.length - MAX_TRACKED) : ids;
  safeSetItem(STORAGE_KEY, JSON.stringify(trimmed));
  // Defer the cross-instance notification to the next microtask. Dispatching
  // synchronously during a setState call has the receiving hook instances
  // call setViewed *while React is still committing the originating update*,
  // which trips the "Cannot update a component while rendering a different
  // component" warning. queueMicrotask runs after the current React commit.
  if (typeof window !== "undefined") {
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent(STORAGE_EVENT));
    });
  }
}

export function useUnreadInvestigations() {
  const [viewed, setViewed] = useState<Set<string>>(() => loadFromStorage());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => setViewed(loadFromStorage());
    // Same-tab updates (other components calling markViewed)
    window.addEventListener(STORAGE_EVENT, onChange);
    // Cross-tab updates (native storage event fires on OTHER tabs only)
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY) onChange();
    });
    return () => {
      window.removeEventListener(STORAGE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const markViewed = useCallback((id: string) => {
    if (!id) return;
    setViewed((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      persist(next);
      return next;
    });
  }, []);

  const markManyViewed = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setViewed((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (id && !next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      if (!changed) return prev;
      persist(next);
      return next;
    });
  }, []);

  const isUnread = useCallback(
    (id: string | undefined | null) => !!id && !viewed.has(id),
    [viewed],
  );

  return { viewed, isUnread, markViewed, markManyViewed };
}

import { useCallback, useEffect, useReducer } from "react";
import { safeGetItem, safeSetItem } from "../lib/utils";

const STORAGE_KEY = "dops:viewed-investigations";
const MAX_TRACKED = 500;

/**
 * Tracks which investigation IDs the user has already opened so the UI can
 * surface unread completions (RCA cards in chat, rows in the Operations Desk
 * Investigation Log) without relying on an ephemeral floating toast.
 *
 * Single source of truth lives at module scope so every hook instance shares
 * the same Set. Mutations notify subscribers synchronously via forceUpdate,
 * so a click in one component (e.g. "Mark all as read" on the Investigations
 * page) immediately clears the NEW indicator in another mounted component
 * (e.g. an RCA card in the Console chat) without waiting on a custom event.
 *
 * Cross-tab sync still rides on the native `storage` event.
 */
let viewedSet: Set<string> | null = null;
const subscribers = new Set<() => void>();

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

function getViewed(): Set<string> {
  if (viewedSet === null) viewedSet = loadFromStorage();
  return viewedSet;
}

function persistAndNotify(set: Set<string>): void {
  const ids = [...set];
  const trimmed = ids.length > MAX_TRACKED ? ids.slice(ids.length - MAX_TRACKED) : ids;
  safeSetItem(STORAGE_KEY, JSON.stringify(trimmed));
  // Notify subscribers in a microtask so any setState that triggered this
  // path commits cleanly before peer hook instances re-render.
  if (subscribers.size > 0) {
    queueMicrotask(() => {
      for (const fn of subscribers) fn();
    });
  }
}

function addToViewed(ids: string[]): void {
  const current = getViewed();
  let changed = false;
  // Build a fresh Set so React memo deps see a new reference and recompute
  // downstream values (isUnread callback, unreadIds memo, etc.). Mutating in
  // place silently kept stale memoized results visible after the click.
  const next = new Set(current);
  for (const id of ids) {
    if (id && !next.has(id)) {
      next.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  viewedSet = next;
  persistAndNotify(next);
}

/**
 * Test-only: drop the in-memory set so a fresh load from storage runs on the
 * next call. Production code should never need this — `addToViewed` is the
 * only mutation path and it keeps the in-memory set in sync.
 */
export function __resetUnreadInvestigationsForTest(): void {
  viewedSet = null;
}

export function useUnreadInvestigations() {
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    subscribers.add(forceUpdate);
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        viewedSet = null; // force reload on next read
        forceUpdate();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
    }
    return () => {
      subscribers.delete(forceUpdate);
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", onStorage);
      }
    };
  }, []);

  const viewed = getViewed();

  const markViewed = useCallback((id: string) => {
    if (id) addToViewed([id]);
  }, []);

  const markManyViewed = useCallback((ids: string[]) => {
    if (ids.length > 0) addToViewed(ids);
  }, []);

  const isUnread = useCallback(
    (id: string | undefined | null) => !!id && !viewed.has(id),
    [viewed],
  );

  return { viewed, isUnread, markViewed, markManyViewed };
}

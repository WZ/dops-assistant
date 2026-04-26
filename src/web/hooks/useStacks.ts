import { useState, useEffect, useCallback, useRef } from "react";
import type { StackSummary } from "../../types/stack-types.js";
import { safeGetItem, safeSetItem } from "../lib/utils";
import { withBase } from "../lib/createStackFetch";
import { staticFetch, isStaticDemoBuild } from "../lib/staticFetch";

const STORAGE_KEY = "dops:lastStackId";

export interface UseStacksResult {
  stacks: StackSummary[];
  activeStackId: string;
  activeStack: StackSummary | undefined;
  switchStack: (stackId: string) => void;
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useStacks(): UseStacksResult {
  const [stacks, setStacks] = useState<StackSummary[]>([]);
  const [activeStackId, setActiveStackId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const fetchStacks = useCallback(async () => {
    try {
      // This hook runs before any stack ID is known, so it can't use the
      // stack-scoped `createStackFetch` wrapper. Route through staticFetch
      // directly when the bundle was built for static-demo mode, otherwise
      // fall back to raw fetch against the live server.
      const res = isStaticDemoBuild()
        ? await staticFetch("/api/stacks", undefined, withBase)
        : await fetch(withBase("/api/stacks"));
      if (!res.ok) return;
      const data = (await res.json()) as StackSummary[];
      setStacks(data);

      // On first load (or if active stack was deleted), pick the right stack
      setActiveStackId((prev) => {
        // If we already have a valid selection, keep it
        if (prev && data.some((s) => s.id === prev)) return prev;

        // Try localStorage
        const stored = safeGetItem(STORAGE_KEY);
        if (stored && data.some((s) => s.id === stored)) return stored;

        // Fall back to default stack
        const defaultStack = data.find((s) => s.isDefault);
        return defaultStack?.id ?? data[0]?.id ?? "";
      });
    } catch {
      /* silently fail — stacks will be empty */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStacks();
  }, [fetchStacks]);

  // Mirror `stacks` into a ref so switchStack can validate against the
  // current list without re-creating its useCallback identity on every
  // stacks update (which would cascade into every consumer's effect deps).
  const stacksRef = useRef(stacks);
  stacksRef.current = stacks;

  const switchStack = useCallback((stackId: string) => {
    // If the target id isn't in our currently-loaded list, refetch in the
    // background. Common case: the locate endpoint returned a stack that
    // was created on another tab, or the stacks list is stale after a
    // rename. Without the refetch, `activeStack` (consumed by the header,
    // StackSwitcher, etc.) resolves to undefined and the UI silently
    // renders blank stack-name strings while the rest of the app still
    // talks to the right stack via the X-Stack-Id header.
    if (stackId && !stacksRef.current.some((s) => s.id === stackId)) {
      void fetchStacks();
    }
    setActiveStackId(stackId);
    safeSetItem(STORAGE_KEY, stackId);
  }, [fetchStacks]);

  const activeStack = stacks.find((s) => s.id === activeStackId);

  return { stacks, activeStackId, activeStack, switchStack, loading, refetch: fetchStacks };
}

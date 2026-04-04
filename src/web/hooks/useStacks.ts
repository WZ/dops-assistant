import { useState, useEffect, useCallback } from "react";
import type { StackSummary } from "../../types/stack-types.js";
import { safeGetItem, safeSetItem } from "../lib/utils";

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
      const res = await fetch("/api/stacks");
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

  const switchStack = useCallback((stackId: string) => {
    setActiveStackId(stackId);
    safeSetItem(STORAGE_KEY, stackId);
  }, []);

  const activeStack = stacks.find((s) => s.id === activeStackId);

  return { stacks, activeStackId, activeStack, switchStack, loading, refetch: fetchStacks };
}

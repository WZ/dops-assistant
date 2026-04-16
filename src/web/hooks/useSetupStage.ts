import { useCallback, useEffect, useRef, useState } from "react";
import { createStackFetch } from "../lib/createStackFetch";
import { safeGetItem, safeSetItem } from "../lib/utils";

export type SetupStage = "needs-provider" | "needs-provider-connected" | "needs-discovery" | "complete";

interface ProviderData {
  name: string;
  status: "connected" | "error" | "unknown";
}

interface UseSetupStageResult {
  stage: SetupStage | null;
  loading: boolean;
  refreshSetupStage: () => void;
}

const POLL_INTERVAL = 5_000;
const INITIAL_TIMEOUT = 3_000;
const COMPLETED_KEY_PREFIX = "dops:setup_completed_at:";

function deriveStage(providers: ProviderData[], serviceCount: number): SetupStage {
  if (providers.length === 0) return "needs-provider";
  const hasConnected = providers.some((p) => p.status === "connected");
  if (!hasConnected) return "needs-provider-connected";
  if (serviceCount === 0) return "needs-discovery";
  return "complete";
}

export function useSetupStage(activeStackId: string): UseSetupStageResult {
  const [stage, setStage] = useState<SetupStage | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const failCountRef = useRef(0);
  const stackIdAtFetchRef = useRef(activeStackId);

  const fetchStage = useCallback(async (stackId: string, signal?: AbortSignal) => {
    const stackFetch = createStackFetch(stackId);
    try {
      const [provRes, svcRes] = await Promise.all([
        stackFetch("/api/providers", { signal }),
        stackFetch("/api/services", { signal }),
      ]);
      if (signal?.aborted) return;
      if (stackId !== stackIdAtFetchRef.current) return;

      const providers: ProviderData[] = await provRes.json();
      const services: unknown[] = await svcRes.json();
      failCountRef.current = 0;

      const derived = deriveStage(providers, services.length);

      if (derived === "complete") {
        const key = COMPLETED_KEY_PREFIX + stackId;
        if (!safeGetItem(key)) {
          safeSetItem(key, new Date().toISOString());
        }
      }

      setStage(derived);
      setLoading(false);
    } catch {
      if (signal?.aborted) return;
      failCountRef.current++;
      if (failCountRef.current >= 3) {
        setLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    fetchStage(activeStackId);
  }, [activeStackId, fetchStage]);

  useEffect(() => {
    stackIdAtFetchRef.current = activeStackId;

    const completedAt = safeGetItem(COMPLETED_KEY_PREFIX + activeStackId);
    if (completedAt) {
      setStage("complete");
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setStage(null);
    failCountRef.current = 0;

    const timeout = setTimeout(() => {
      if (loading) {
        setLoading(false);
      }
    }, INITIAL_TIMEOUT);

    fetchStage(activeStackId, controller.signal);

    pollRef.current = setInterval(() => {
      if (stage !== "complete") {
        fetchStage(activeStackId, controller.signal);
      }
    }, POLL_INTERVAL);

    return () => {
      clearTimeout(timeout);
      clearInterval(pollRef.current);
      controller.abort();
    };
  }, [activeStackId, fetchStage]);

  useEffect(() => {
    if (stage === "complete") {
      clearInterval(pollRef.current);
    }
  }, [stage]);

  return { stage, loading, refreshSetupStage: refresh };
}

// src/web/hooks/useScanActivity.ts
import { useEffect, useState } from "react";
import { useStackContext } from "../contexts/StackContext.js";

/**
 * Shape of GET /api/scan/activity. Mirrors the server's response verbatim.
 * If the server response shape changes, update this type in lockstep —
 * there's no shared type file between server routes and web, intentionally
 * keeping the contract lightweight.
 */
export interface ScanActivity {
  enabled: boolean;
  ticking: boolean;
  lastRun: string | null;
  nextRun: string | null;
  lastError: string | null;
  dropsByConcurrency: number;
  windowHours: number;
  recentAnomalies: number;
}

interface Options {
  pollMs?: number;
  enabled?: boolean;
  windowHours?: 1 | 6 | 24 | 168;
}

interface State {
  activity: ScanActivity | null;
  loading: boolean;
  error: string | null;
}

/**
 * Polls /api/scan/activity for the Dashboard badge. Same backoff shape as
 * `useRecentEvents`: doubles on error up to 60s, resets on success — avoids
 * hammering a flapping endpoint from every open tab during an incident.
 */
export function useScanActivity(opts: Options = {}): State {
  const { pollMs = 30_000, enabled = true, windowHours } = opts;
  const { stackFetch } = useStackContext();
  const [state, setState] = useState<State>({ activity: null, loading: true, error: null });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | null = null;
    let currentDelay = pollMs;
    const maxDelay = 60_000;

    const windowParam =
      windowHours === 1 ? "1h"
      : windowHours === 6 ? "6h"
      : windowHours === 168 ? "7d"
      : "24h";

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = window.setTimeout(fetchOnce, delay);
    };

    const fetchOnce = async () => {
      try {
        const res = await stackFetch(`/api/scan/activity?window=${windowParam}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ScanActivity;
        if (cancelled) return;
        currentDelay = pollMs;
        setState({ activity: body, loading: false, error: null });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState((prev) => ({ ...prev, loading: false, error: message }));
        currentDelay = Math.min(currentDelay * 2, maxDelay);
      }
      schedule(currentDelay);
    };

    fetchOnce();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pollMs, enabled, stackFetch, windowHours]);

  return state;
}

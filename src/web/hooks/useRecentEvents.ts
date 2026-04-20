// src/web/hooks/useRecentEvents.ts
import { useEffect, useState } from "react";
import type { RecentEvent, RecentEventsResponse } from "../../types/events.js";
import { useStackContext } from "../contexts/StackContext.js";

interface Options {
  limit?: number;
  pollMs?: number;
  enabled?: boolean;
}

interface State {
  events: RecentEvent[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
}

export function useRecentEvents(opts: Options = {}): State {
  const { limit = 50, pollMs = 5000, enabled = true } = opts;
  const { stackFetch } = useStackContext();
  const [state, setState] = useState<State>({ events: [], loading: true, error: null, truncated: false });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const res = await stackFetch(`/api/events/recent?limit=${limit}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as RecentEventsResponse;
        if (cancelled) return;
        setState({ events: body.events, loading: false, error: null, truncated: body.truncated });
      } catch (e) {
        if (cancelled) return;
        setState((prev) => ({ ...prev, loading: false, error: (e as Error).message }));
      }
    };

    fetchOnce();
    const timer = window.setInterval(fetchOnce, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [limit, pollMs, enabled, stackFetch]);

  return state;
}

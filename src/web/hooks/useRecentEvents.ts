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
    let timer: number | null = null;
    // On error, double the delay up to 60s; reset on success. Avoids hammering a
    // flapping endpoint from every open tab during an incident.
    let currentDelay = pollMs;
    const maxDelay = 60_000;

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = window.setTimeout(fetchOnce, delay);
    };

    const fetchOnce = async () => {
      try {
        const res = await stackFetch(`/api/events/recent?limit=${limit}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as RecentEventsResponse;
        if (cancelled) return;
        currentDelay = pollMs;
        setState({ events: body.events, loading: false, error: null, truncated: body.truncated });
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
  }, [limit, pollMs, enabled, stackFetch]);

  return state;
}

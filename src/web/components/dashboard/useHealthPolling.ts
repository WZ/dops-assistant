import { useEffect, useRef, useState } from "react";

export interface ProbeResult {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number; // seconds
  probes: {
    mcp: ProbeResult;
    db: ProbeResult;
  };
  lastCheck: string; // ISO 8601
}

export interface HealthPollingResult {
  health: HealthStatus | null; // null during initial load
  connectionState: "connected" | "unknown" | "unreachable";
  consecutiveFailures: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const UNREACHABLE_THRESHOLD = 3;

export function useHealthPolling(intervalMs = DEFAULT_INTERVAL_MS): HealthPollingResult {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [connectionState, setConnectionState] = useState<HealthPollingResult["connectionState"]>("connected");
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  // Use a ref so the poll closure always reads the latest failure count without
  // triggering a re-render cycle when updating the interval.
  const consecutiveFailuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as HealthStatus;

        if (cancelled) return;

        consecutiveFailuresRef.current = 0;
        setConsecutiveFailures(0);
        setHealth(data);
        setConnectionState("connected");
      } catch {
        if (cancelled) return;

        consecutiveFailuresRef.current += 1;
        const failures = consecutiveFailuresRef.current;
        setConsecutiveFailures(failures);

        if (failures >= UNREACHABLE_THRESHOLD) {
          setConnectionState("unreachable");
          setHealth(null);
        } else {
          setConnectionState("unknown");
          // Keep last known health data (do not clear `health`)
        }
      }
    }

    // Poll immediately on mount
    poll();

    const handle = setInterval(poll, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [intervalMs]);

  return { health, connectionState, consecutiveFailures };
}

import { useEffect, useMemo, useState } from "react";
import { useStackContext } from "../../contexts/StackContext";

const BUCKET_COUNT = 48; // 24h ÷ 48 = 30-minute buckets
const SEVERITY: Record<string, number> = { down: 3, degraded: 2, unknown: 1, healthy: 0 };

interface HealthPoint {
  status: string;
}

/** Normalize variable-length health data into fixed-width buckets.
 *  Each bucket uses the worst status observed in that time window. */
function bucketize(data: HealthPoint[], count: number): HealthPoint[] {
  if (data.length <= count) {
    const padded = [...data];
    while (padded.length < count) padded.unshift({ status: "empty" });
    return padded;
  }
  const bucketSize = data.length / count;
  const buckets: HealthPoint[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let worst = "healthy";
    for (let j = start; j < end; j++) {
      if ((SEVERITY[data[j].status] ?? 0) > (SEVERITY[worst] ?? 0)) {
        worst = data[j].status;
      }
    }
    buckets.push({ status: worst });
  }
  return buckets;
}

interface Props {
  service: string;
  hours?: number;
}

export function HealthDotTimeline({ service, hours = 24 }: Props) {
  const { stackFetch } = useStackContext();
  const [data, setData] = useState<HealthPoint[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    stackFetch(`/api/services/health/history?service=${encodeURIComponent(service)}&hours=${hours}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setData(Array.isArray(body) ? body : []);
      })
      .catch(() => { /* non-critical */ });
    return () => { cancelled = true; };
  }, [service, hours, stackFetch]);

  const buckets = useMemo(() => (data ? bucketize(data, BUCKET_COUNT) : null), [data]);

  if (!buckets || (data?.length ?? 0) < 3) {
    return <span className="font-mono text-[9px] text-muted-foreground/40">—</span>;
  }

  const healthyCount = data!.filter((d) => d.status === "healthy").length;
  const downCount = data!.filter((d) => d.status === "down").length;

  return (
    <div
      className="flex gap-[1.5px] items-center"
      role="img"
      aria-label={`24h health: ${healthyCount} of ${data!.length} checks healthy${downCount > 0 ? `, ${downCount} down` : ""}`}
    >
      {buckets.map((b, i) => (
        <div
          key={i}
          className="rounded-[1px]"
          style={{
            flex: "1 1 0",
            minWidth: 2,
            maxWidth: 6,
            height: 10,
            background: b.status === "empty"
              ? "var(--color-muted-foreground)"
              : b.status === "healthy"
              ? "var(--color-success)"
              : b.status === "down"
              ? "var(--color-destructive)"
              : b.status === "degraded"
              ? "var(--color-warning)"
              : "var(--color-muted-foreground)",
            opacity: b.status === "empty" ? 0.1
              : b.status === "down" ? 1
              : b.status === "healthy" ? 0.75
              : 0.5,
          }}
        />
      ))}
    </div>
  );
}

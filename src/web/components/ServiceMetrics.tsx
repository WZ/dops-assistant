import { useState, useEffect } from "react";
import { MetricChart, type TimeSeriesData } from "./MetricChart";

interface MetricSeries {
  name: string;
  query: string;
  unit: string;
  current: number;
  values: [string, number][];
  min?: number;
  max?: number;
  avg?: number;
  fetchedAt?: number;
}

interface ServiceMetricsProps {
  serviceName: string;
}

type TimeRange = "1h" | "6h" | "24h" | "7d";

function formatMetricValue(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  if (Math.abs(v) < 0.01 && v !== 0) return v.toExponential(1);
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(2);
}

function seriesToChartData(series: MetricSeries): TimeSeriesData {
  // Guard: ensure values is always a valid array of [string, number] tuples
  const values = (series.values ?? []).filter(
    (v): v is [string, number] => Array.isArray(v) && v.length >= 2
  );
  return {
    metric: series.name,
    query: series.query,
    values,
    min: series.min,
    max: series.max,
    avg: series.avg,
  };
}

export function ServiceMetrics({ serviceName }: ServiceMetricsProps) {
  const [range, setRange] = useState<TimeRange>("24h");
  const [metrics, setMetrics] = useState<MetricSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const controller = new AbortController();

    fetch(`/api/services/${encodeURIComponent(serviceName)}/metrics?range=${range}`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setMetrics(data.metrics ?? []);
        setCached(data.cached ?? false);
        setFetchedAt(data.fetchedAt ?? null);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [serviceName, range]);

  return (
    <div>
      {/* Time picker row */}
      <div className="flex items-center gap-2 mb-5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60">
          Time Range
        </span>
        {(["1h", "6h", "24h", "7d"] as TimeRange[]).map((preset) => (
          <button
            key={preset}
            onClick={() => setRange(preset)}
            className={`px-2.5 py-2 min-h-[44px] rounded-md text-[11px] font-mono transition-colors ${
              range === preset
                ? "border border-primary/60 text-primary bg-primary/5"
                : "border border-border/30 text-muted-foreground hover:text-foreground hover:border-border/60"
            }`}
          >
            {preset}
          </button>
        ))}
        {cached && fetchedAt && (
          <span className="text-[10px] text-muted-foreground/50 font-mono ml-auto">
            Cached · {Math.round((Date.now() - fetchedAt) / 1000)}s ago
          </span>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Prometheus connection unavailable. Check provider configuration.
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-40 rounded-lg bg-muted/30 shimmer-skeleton" />
          ))}
        </div>
      )}

      {/* Metric cards grid */}
      {!loading && !error && metrics.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          {metrics.map((series) => {
            const chartData = seriesToChartData(series);
            if (chartData.values.length < 2) {
              // Single data point — show as stat card instead of empty chart
              return (
                <div key={series.name} className="space-y-2">
                  <span className="text-[12px] font-body text-muted-foreground font-medium">{series.name}</span>
                  <div className="h-[130px] rounded-lg border border-border/25 bg-card/40 flex flex-col items-center justify-center gap-1">
                    <span className="font-mono text-[28px] font-semibold tabular-nums">
                      {series.current != null ? formatMetricValue(series.current) : "—"}
                    </span>
                    {series.unit && (
                      <span className="text-[11px] text-muted-foreground/50 font-mono">{series.unit}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground/30 font-mono">current value</span>
                  </div>
                </div>
              );
            }
            return (
              <div key={series.name} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-muted-foreground font-medium">
                    {series.name}
                  </span>
                  <span className="font-mono text-lg font-semibold tabular-nums">
                    {series.current != null ? formatMetricValue(series.current) : "—"}{" "}
                    <span className="text-[11px] text-muted-foreground font-normal">
                      {series.unit}
                    </span>
                  </span>
                </div>
                <MetricChart series={chartData} />
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && metrics.length === 0 && (
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-40 rounded-lg border border-border/25 bg-card/40 flex items-center justify-center"
            >
              <span className="font-mono text-xl text-muted-foreground/40">—</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

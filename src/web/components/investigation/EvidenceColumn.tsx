/**
 * EvidenceColumn — right-side panel showing mini sparkline charts extracted
 * from investigation tool call results (query_prometheus calls).
 *
 * ChartItem mirrors TimeSeriesData from MetricChart.tsx so InvestigationPane
 * can pass its `timeSeries` state directly without reshaping.
 */

export interface ChartItem {
  /** Prometheus metric name (from item.m or similar). */
  metric: string;
  /** Optional instance label. */
  instance?: string;
  /** PromQL expression from tool call args (query / expr / expression). */
  query?: string;
  /** Time-series values: [epoch_seconds_as_string, numeric_value][]. */
  values: [string, number][];
  min?: number;
  max?: number;
  avg?: number;
  /** Optional tool/provider label, e.g. "prometheus". */
  source?: string;
}

interface Props {
  charts: ChartItem[];
}

function MiniSpark({ values }: { values: [string, number][] }) {
  if (values.length < 2) return null;
  const nums = values.map(([, v]) => v);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const w = 280;
  const h = 40;
  const pts = values
    .map(([, v], i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="block"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Derive the display label: prefer query, fall back to metric + instance. */
function chartLabel(c: ChartItem): string {
  if (c.query) return c.query;
  if (c.instance) return `${c.metric}{${c.instance}}`;
  return c.metric;
}

export function EvidenceColumn({ charts }: Props) {
  if (charts.length === 0) {
    return (
      <aside
        aria-label="Evidence"
        className="w-full lg:w-[360px] shrink-0 px-5 py-6 border-l border-border/30"
      >
        <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 mb-3">
          Evidence
        </h2>
        <p className="font-mono text-[11px] text-muted-foreground/50">
          No evidence charts yet.
        </p>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Evidence"
      className="w-full lg:w-[360px] shrink-0 px-5 py-6 border-l border-border/30 space-y-4"
    >
      <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
        Evidence
      </h2>
      {charts.map((c, i) => (
        <div
          key={i}
          className="rounded-md border border-border/40 bg-card/60 p-3"
        >
          <div className="font-mono text-[10px] text-muted-foreground/70 truncate mb-2">
            {chartLabel(c)}
          </div>
          <MiniSpark values={c.values} />
          {(c.min != null || c.max != null || c.avg != null) && (
            <div className="flex gap-3 mt-1 font-mono text-[9px] text-muted-foreground/50">
              {c.min != null && <span>min {c.min.toFixed(2)}</span>}
              {c.avg != null && <span>avg {c.avg.toFixed(2)}</span>}
              {c.max != null && <span>max {c.max.toFixed(2)}</span>}
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}

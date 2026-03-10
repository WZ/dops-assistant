import { useMemo, useState } from "react";

export interface TimeSeriesData {
  metric: string;
  instance?: string;
  values: [string, number][]; // [ISO timestamp, value]
  min?: number;
  max?: number;
  avg?: number;
}

function formatValue(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  if (Math.abs(v) < 0.01 && v !== 0) return v.toExponential(1);
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(2);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const CHART_H = 100;
const CHART_W = 320;
const PAD = { top: 8, right: 8, bottom: 20, left: 44 };

export function MetricChart({ series }: { series: TimeSeriesData }) {
  const [hover, setHover] = useState<number | null>(null);

  const { points, yMin, yMax, xLabels, plotW, plotH } = useMemo(() => {
    const vals = series.values;
    if (vals.length === 0) return { points: [], yMin: 0, yMax: 0, xLabels: [] as string[], plotW: 0, plotH: 0 };

    const nums = vals.map(([, v]) => v);
    let lo = Math.min(...nums);
    let hi = Math.max(...nums);
    // Add 10% padding so line doesn't touch edges
    const range = hi - lo || 1;
    lo = lo - range * 0.05;
    hi = hi + range * 0.05;

    const pw = CHART_W - PAD.left - PAD.right;
    const ph = CHART_H - PAD.top - PAD.bottom;

    const pts = vals.map(([ts, v], i) => ({
      x: PAD.left + (i / Math.max(vals.length - 1, 1)) * pw,
      y: PAD.top + (1 - (v - lo) / (hi - lo)) * ph,
      value: v,
      time: ts,
    }));

    // Pick ~4 evenly spaced time labels
    const labelCount = Math.min(4, vals.length);
    const labels: string[] = [];
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.round((i / (labelCount - 1)) * (vals.length - 1));
      labels.push(formatTime(vals[idx][0]));
    }

    return { points: pts, yMin: lo, yMax: hi, xLabels: labels, plotW: pw, plotH: ph };
  }, [series.values]);

  if (points.length < 2) return null;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${PAD.top + plotH} L${points[0].x.toFixed(1)},${PAD.top + plotH} Z`;

  const hoverPoint = hover !== null ? points[hover] : null;

  return (
    <div className="rounded-lg border border-border/25 bg-card/30 px-3.5 py-2.5 card-lift animate-fade-up">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-[11px] text-foreground/70 truncate">{series.metric}</span>
        {series.instance && <span className="text-[9px] font-mono text-muted-foreground/40 truncate ml-2">{series.instance}</span>}
      </div>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full h-auto"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * CHART_W;
          const closest = points.reduce((best, p, i) => (Math.abs(p.x - x) < Math.abs(points[best].x - x) ? i : best), 0);
          setHover(closest);
        }}
      >
        {/* Grid lines */}
        {[0, 0.5, 1].map((frac) => {
          const y = PAD.top + (1 - frac) * plotH;
          const val = yMin + frac * (yMax - yMin);
          return (
            <g key={frac}>
              <line x1={PAD.left} y1={y} x2={PAD.left + plotW} y2={y} stroke="currentColor" className="text-border/30" strokeWidth="0.5" strokeDasharray="3,3" />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" className="text-muted-foreground/40" fontSize="7" fontFamily="var(--font-mono)">
                {formatValue(val)}
              </text>
            </g>
          );
        })}

        {/* X-axis labels */}
        {xLabels.map((label, i) => {
          const x = PAD.left + (i / (xLabels.length - 1)) * plotW;
          return (
            <text key={i} x={x} y={CHART_H - 2} textAnchor="middle" className="text-muted-foreground/40" fontSize="7" fontFamily="var(--font-mono)">
              {label}
            </text>
          );
        })}

        {/* Area fill */}
        <path d={areaPath} fill="url(#chartGrad)" opacity="0.25" />

        {/* Line */}
        <path d={linePath} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />

        {/* Hover indicator */}
        {hoverPoint && (
          <>
            <line x1={hoverPoint.x} y1={PAD.top} x2={hoverPoint.x} y2={PAD.top + plotH} stroke="hsl(var(--primary))" strokeWidth="0.5" opacity="0.5" />
            <circle cx={hoverPoint.x} cy={hoverPoint.y} r="3" fill="hsl(var(--primary))" stroke="hsl(var(--background))" strokeWidth="1.5" />
            <rect x={hoverPoint.x - 30} y={hoverPoint.y - 18} width="60" height="14" rx="3" fill="hsl(var(--card))" stroke="hsl(var(--border))" strokeWidth="0.5" />
            <text x={hoverPoint.x} y={hoverPoint.y - 9} textAnchor="middle" className="text-foreground/80" fontSize="7" fontFamily="var(--font-mono)">
              {formatValue(hoverPoint.value)}
            </text>
          </>
        )}

        {/* Gradient definition */}
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      {/* Stats row */}
      {(series.min !== undefined || series.avg !== undefined || series.max !== undefined) && (
        <div className="flex gap-3 mt-1 text-[9px] font-mono text-muted-foreground/45">
          {series.min !== undefined && <span>min {formatValue(series.min)}</span>}
          {series.avg !== undefined && <span>avg {formatValue(series.avg)}</span>}
          {series.max !== undefined && <span>max {formatValue(series.max)}</span>}
        </div>
      )}
    </div>
  );
}

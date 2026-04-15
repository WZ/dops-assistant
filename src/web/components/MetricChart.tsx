import { useMemo, useState, useId } from "react";

export interface TimeSeriesData {
  metric: string;
  instance?: string;
  query?: string; // PromQL expression from tool call args
  values: [string, number][]; // [timestamp (epoch seconds or ISO), value]
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

function parseTimestamp(ts: string): Date {
  // Prometheus returns Unix epoch seconds as strings; ISO strings contain non-digit chars
  if (/^\d+(\.\d+)?$/.test(ts)) return new Date(Number(ts) * 1000);
  return new Date(ts);
}

function formatTime(ts: string): string {
  const d = parseTimestamp(ts);
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mo}/${day} ${hh}:${mm}`;
}

/** Extract a readable metric name from the PromQL query or compacted metric key */
function resolveTitle(series: TimeSeriesData): string {
  // If the compacted metric name is valid (e.g. "kafka_producer_record_error_total"), use it
  if (series.metric && series.metric !== "unknown" && series.metric !== "/" && series.metric.trim() !== "") {
    if (series.instance) return `${series.metric} · ${series.instance}`;
    return series.metric;
  }
  // Fall back to PromQL — extract the innermost metric name from the expression
  if (series.query) {
    // Try: metric name followed by { or [ (most common pattern)
    const m1 = series.query.match(/\b([a-zA-Z_:][a-zA-Z0-9_:]+)\s*[{\[]/);
    // Try: metric name containing underscore (catches names without selectors, skips PromQL funcs)
    const m2 = series.query.match(/\b([a-zA-Z][a-zA-Z0-9_:]*_[a-zA-Z0-9_:]+)\b/);
    const name = m1?.[1] ?? m2?.[1];
    if (name) {
      const fnMatch = series.query.match(/^(sum|avg|max|min|count|rate|irate|increase|histogram_quantile)\s*\(/i);
      const fn = fnMatch ? fnMatch[1] : "";
      const label = fn ? `${fn}(${name})` : name;
      if (series.instance) return `${label} · ${series.instance}`;
      return label;
    }
    // No metric name found — show cleaned query
    const short = series.query.length > 60 ? series.query.slice(0, 57) + "…" : series.query;
    return short;
  }
  return "metric";
}

const CHART_H = 130;
const CHART_W = 360;
const PAD = { top: 10, right: 28, bottom: 28, left: 48 };

export function MetricChart({ series, bare }: { series: TimeSeriesData; bare?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/:/g, "");

  const title = resolveTitle(series);

  const { points, yMin, yMax, xLabels, plotW, plotH } = useMemo(() => {
    const vals = series.values;
    if (vals.length === 0) return { points: [], yMin: 0, yMax: 0, xLabels: [] as string[], plotW: 0, plotH: 0 };

    const nums = vals.map(([, v]) => v);
    let lo = Math.min(...nums);
    let hi = Math.max(...nums);
    const range = hi - lo || 1;
    lo = lo - range * 0.08;
    hi = hi + range * 0.08;

    const pw = CHART_W - PAD.left - PAD.right;
    const ph = CHART_H - PAD.top - PAD.bottom;

    const pts = vals.map(([ts, v], i) => ({
      x: PAD.left + (i / Math.max(vals.length - 1, 1)) * pw,
      y: PAD.top + (1 - (v - lo) / (hi - lo)) * ph,
      value: v,
      time: ts,
    }));

    const labelCount = Math.min(4, vals.length);
    const labels: string[] = [];
    for (let i = 0; i < labelCount; i++) {
      const idx = labelCount <= 1 ? 0 : Math.round((i / (labelCount - 1)) * (vals.length - 1));
      if (vals[idx]) labels.push(formatTime(vals[idx][0]));
    }

    return { points: pts, yMin: lo, yMax: hi, xLabels: labels, plotW: pw, plotH: ph };
  }, [series.values]);

  if (points.length < 2) return null;

  // Smooth the line with cardinal spline interpolation for a more polished look
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${PAD.top + plotH} L${points[0].x.toFixed(1)},${PAD.top + plotH} Z`;

  const hoverPoint = hover !== null ? points[hover] : null;

  // Colors as HSL strings referencing CSS variables — works in SVG fill/stroke
  const cMuted = "hsl(var(--muted-foreground) / 0.4)";
  const cBorder = "hsl(var(--border) / 0.3)";
  const cPrimary = "hsl(var(--primary))";
  const cPrimaryFaint = "hsl(var(--primary) / 0.12)";
  const cCard = "hsl(var(--card))";
  const cFg = "hsl(var(--foreground) / 0.8)";
  const cBorderSolid = "hsl(var(--border))";

  // Cap visual width so the SVG (viewBox 360×130) doesn't balloon in wide
  // columns — at 2x+ upscale the fontSize="7" axis labels visually become
  // 14-16px, making the chart look blown up relative to surrounding text.
  const chartSvg = (
      <div className={bare ? "max-w-[480px]" : "px-2 pt-1 pb-1 max-w-[480px]"}>
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="w-full h-auto select-none"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * CHART_W;
            const closest = points.reduce((best, p, i) =>
              Math.abs(p.x - x) < Math.abs(points[best].x - x) ? i : best, 0);
            setHover(closest);
          }}
        >
          <defs>
            <linearGradient id={`areaGrad-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={cPrimary} stopOpacity="0.2" />
              <stop offset="100%" stopColor={cPrimary} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`lineGrad-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={cPrimary} stopOpacity="0.6" />
              <stop offset="30%" stopColor={cPrimary} stopOpacity="1" />
              <stop offset="70%" stopColor={cPrimary} stopOpacity="1" />
              <stop offset="100%" stopColor={cPrimary} stopOpacity="0.6" />
            </linearGradient>
          </defs>

          {/* Plot background */}
          <rect
            x={PAD.left} y={PAD.top}
            width={plotW} height={plotH}
            fill={cPrimaryFaint}
            rx="2"
          />

          {/* Horizontal grid lines + Y-axis labels */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const y = PAD.top + (1 - frac) * plotH;
            const val = yMin + frac * (yMax - yMin);
            return (
              <g key={frac}>
                <line
                  x1={PAD.left} y1={y}
                  x2={PAD.left + plotW} y2={y}
                  stroke={cBorder}
                  strokeWidth="0.5"
                />
                <text
                  x={PAD.left - 5} y={y + 3}
                  textAnchor="end"
                  fill={cMuted}
                  fontSize="7"
                  fontFamily="var(--font-mono)"
                >
                  {formatValue(val)}
                </text>
              </g>
            );
          })}

          {/* X-axis labels */}
          {xLabels.map((label, i) => {
            const x = PAD.left + (i / (xLabels.length - 1)) * plotW;
            return (
              <text
                key={i}
                x={x} y={CHART_H - 6}
                textAnchor="middle"
                fill={cMuted}
                fontSize="6"
                fontFamily="var(--font-mono)"
              >
                {label}
              </text>
            );
          })}

          {/* Area fill */}
          <path d={areaPath} fill={`url(#areaGrad-${uid})`} />

          {/* Line */}
          <path
            d={linePath}
            fill="none"
            stroke={`url(#lineGrad-${uid})`}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Hover crosshair + tooltip */}
          {hoverPoint && (
            <>
              {/* Vertical guide */}
              <line
                x1={hoverPoint.x} y1={PAD.top}
                x2={hoverPoint.x} y2={PAD.top + plotH}
                stroke={cPrimary} strokeWidth="0.5" opacity="0.35"
                strokeDasharray="2,2"
              />
              {/* Horizontal guide */}
              <line
                x1={PAD.left} y1={hoverPoint.y}
                x2={PAD.left + plotW} y2={hoverPoint.y}
                stroke={cPrimary} strokeWidth="0.5" opacity="0.2"
                strokeDasharray="2,2"
              />
              {/* Dot */}
              <circle
                cx={hoverPoint.x} cy={hoverPoint.y} r="3.5"
                fill={cPrimary}
                stroke={cCard}
                strokeWidth="2"
              />
              {/* Glow ring */}
              <circle
                cx={hoverPoint.x} cy={hoverPoint.y} r="6"
                fill="none"
                stroke={cPrimary}
                strokeWidth="0.5"
                opacity="0.3"
              />
              {/* Tooltip background */}
              <rect
                x={hoverPoint.x - 46} y={hoverPoint.y - 22}
                width="92" height="16"
                rx="4"
                fill={cCard}
                stroke={cBorderSolid}
                strokeWidth="0.5"
              />
              {/* Tooltip value */}
              <text
                x={hoverPoint.x} y={hoverPoint.y - 11.5}
                textAnchor="middle"
                fill={cFg}
                fontSize="7.5"
                fontFamily="var(--font-mono)"
                fontWeight="500"
              >
                {formatValue(hoverPoint.value)} · {formatTime(hoverPoint.time)}
              </text>
            </>
          )}
        </svg>
      </div>
  );

  const statsFooter = (series.min !== undefined || series.avg !== undefined || series.max !== undefined) ? (
    <div className="flex items-center gap-4 px-3.5 py-1.5 border-t border-border/10 bg-secondary/10">
      {series.min !== undefined && (
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-mono text-muted-foreground/65 uppercase">min</span>
          <span className="text-[9px] font-mono text-foreground/55">{formatValue(series.min)}</span>
        </div>
      )}
      {series.avg !== undefined && (
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-mono text-muted-foreground/65 uppercase">avg</span>
          <span className="text-[9px] font-mono text-primary/70">{formatValue(series.avg)}</span>
        </div>
      )}
      {series.max !== undefined && (
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-mono text-muted-foreground/65 uppercase">max</span>
          <span className="text-[9px] font-mono text-foreground/55">{formatValue(series.max)}</span>
        </div>
      )}
      <div className="ml-auto">
        <span className="text-[8px] font-mono text-muted-foreground/55">{series.values.length} pts</span>
      </div>
    </div>
  ) : null;

  if (bare) {
    return <>{chartSvg}{statsFooter}</>;
  }

  return (
    <div className="rounded-lg border border-border/25 bg-card/40 overflow-hidden animate-fade-up card-lift">
      {/* Title bar */}
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-border/15">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
          <span className="font-mono text-[10px] text-foreground/65 truncate">{title}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {series.instance && (
            <span className="text-[8px] font-mono text-muted-foreground/65 px-1.5 py-0.5 rounded bg-secondary/30 border border-border/15">
              {series.instance}
            </span>
          )}
        </div>
      </div>
      {chartSvg}
      {statsFooter}
    </div>
  );
}

import type { TimeSeriesData } from "../MetricChart";
import { extractMetricExpression } from "../../../lib/prom-metric.js";

/**
 * Generate a believable time series for a metric observation in static demo
 * mode. Used when /api/metrics/extract isn't available (Pages can't run POST
 * endpoints) so investigation evidence cards still render charts.
 *
 * The shape is informed by the observation text — we look for patterns like
 * "climbed from X to Y", "spiked from X to Y", "reached X", "averaged X" to
 * pick a plausible start/end value. Falls back to a flat-ish baseline series
 * when no numeric anchors are recognized.
 *
 * Series is deterministic per (text, service) so re-renders don't reshuffle.
 */
export function synthesizeDemoSeries(text: string, service: string): TimeSeriesData {
  const query = extractMetricExpression(text) ?? text.slice(0, 60);
  const { startVal, endVal, peakVal } = inferRange(text);
  const points = 60;
  const values = buildShape(`${service}:${query}`, points, startVal, endVal, peakVal);
  const nums = values.map((v) => v[1]);

  return {
    metric: query,
    query,
    values,
    min: Math.min(...nums),
    max: Math.max(...nums),
    avg: nums.reduce((a, b) => a + b, 0) / nums.length,
  };
}

// ── Numeric range inference ─────────────────────────────────────────────────

/**
 * Pull plausible start / end / peak values out of an observation sentence.
 * Examples handled:
 *   "climbed from 0.0 to 18.4/s over 11 min" → start=0, end=18.4
 *   "spiked from 240ms baseline to 5.1s"     → start=0.24, end=5.1
 *   "reached 100% at peak"                   → start=peak/3, end=peak
 *   "averaged 47 waiters"                    → start=avg, end=avg, peak=avg*1.4
 */
function inferRange(text: string): { startVal: number; endVal: number; peakVal: number } {
  const fromTo = /from\s+([\d.]+)\s*([%a-zA-Z/]*)\s+(?:baseline\s+)?to\s+([\d.]+)\s*([%a-zA-Z/]*)/i.exec(text);
  if (fromTo) {
    const start = normalizeUnit(parseFloat(fromTo[1]!), fromTo[2] ?? "");
    const end   = normalizeUnit(parseFloat(fromTo[3]!), fromTo[4] ?? "");
    return { startVal: start, endVal: end, peakVal: Math.max(start, end) };
  }
  const reached = /reached\s+([\d.]+)\s*([%a-zA-Z/]*)/i.exec(text);
  if (reached) {
    const v = normalizeUnit(parseFloat(reached[1]!), reached[2] ?? "");
    return { startVal: v / 3, endVal: v, peakVal: v };
  }
  const avg = /averaged\s+([\d.]+)/i.exec(text);
  if (avg) {
    const v = parseFloat(avg[1]!);
    return { startVal: v * 0.7, endVal: v * 0.9, peakVal: v * 1.4 };
  }
  const single = /([\d.]+)\s*([%a-zA-Z/]*)/i.exec(text);
  if (single) {
    const v = normalizeUnit(parseFloat(single[1]!), single[2] ?? "");
    if (Number.isFinite(v) && v > 0) {
      return { startVal: v * 0.4, endVal: v, peakVal: v * 1.1 };
    }
  }
  return { startVal: 0.4, endVal: 0.9, peakVal: 1.0 };
}

/** Normalize a value+unit pair to a single comparable number (rough). */
function normalizeUnit(v: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("ms")) return v / 1000;
  if (u.startsWith("%"))  return v / 100;
  return v;
}

// ── Shape generator (random-walk with spike trajectory) ─────────────────────

/** Mulberry32 PRNG seeded from a string. */
function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  }
  return () => {
    h |= 0; h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a points-long series that starts near startVal, ends near endVal,
 * and peaks somewhere near peakVal in the last third (typical incident shape).
 * Adds small per-step noise so the line isn't clinically smooth.
 */
function buildShape(seed: string, points: number, startVal: number, endVal: number, peakVal: number): [string, number][] {
  const rng = seededRng(seed);
  const stepSec = 60;
  const start = Math.floor(Date.now() / 1000) - points * stepSec;
  const out: [string, number][] = [];
  const peakIdx = Math.floor(points * 0.7);
  const span = Math.max(0.0001, peakVal - startVal);
  const noise = span * 0.06;

  for (let i = 0; i < points; i++) {
    let target: number;
    if (i <= peakIdx) {
      const t = i / peakIdx;
      target = startVal + (peakVal - startVal) * t;
    } else {
      const t = (i - peakIdx) / (points - peakIdx);
      target = peakVal + (endVal - peakVal) * t;
    }
    const v = Math.max(0, target + (rng() - 0.5) * noise * 2);
    out.push([String(start + i * stepSec), +v.toFixed(3)]);
  }
  return out;
}

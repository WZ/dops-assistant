import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { MetricChart, type TimeSeriesData } from "../MetricChart";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useStackContext } from "../../contexts/StackContext";
import { extractMetricExpression } from "../../../lib/prom-metric.js";
import { isStaticDemoBuild } from "../../lib/staticFetch";
import { synthesizeDemoSeries } from "./demo-series";

export interface StructuredMetricObs {
  metric: string;
  currentValue: string;
  baselineValue: string;
  severity?: string;
}

interface MetricsPanelProps {
  timeSeries: TimeSeriesData[];
  textObservations: string[];
  structuredObservations?: StructuredMetricObs[];
  service: string;
  timeRange?: { from: string; to: string };
  /** URL builder for per-chart Grafana links. Called with the PromQL query. */
  buildChartUrl?: (query: string) => string;
}

interface ExtractionResult {
  text: string;
  series: TimeSeriesData[];
  loading: boolean;
  failed: boolean;
}

const MAX_EXTRACTIONS = 5;

export function MetricsPanel({ timeSeries, textObservations, structuredObservations, service, timeRange, buildChartUrl }: MetricsPanelProps) {
  const { stackFetch } = useStackContext();
  const [extractions, setExtractions] = useState<ExtractionResult[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (textObservations.length === 0) return;

    // Static demo: there's no /api/metrics/extract POST to call (mutations are
    // 403'd in static mode). Synthesize a believable random-walk series per
    // observation so the evidence cards render charts instead of empty
    // "no data" placeholders.
    if (isStaticDemoBuild()) {
      const toExtract = textObservations.slice(0, MAX_EXTRACTIONS);
      setExtractions(toExtract.map((text) => ({
        text,
        series: [synthesizeDemoSeries(text, service)],
        loading: false,
        failed: false,
      })));
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const toExtract = textObservations.slice(0, MAX_EXTRACTIONS);

    setExtractions(toExtract.map(text => ({ text, series: [], loading: true, failed: false })));

    toExtract.forEach((text, idx) => {
      stackFetch("/api/metrics/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, service, timeRange }),
        signal: controller.signal,
      })
        .then(res => res.ok ? res.json() : { series: [] })
        .then(data => {
          if (controller.signal.aborted) return;
          setExtractions(prev => prev.map((e, i) => i === idx ? { ...e, series: data.series ?? [], loading: false } : e));
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setExtractions(prev => prev.map((e, i) => i === idx ? { ...e, loading: false, failed: true } : e));
        });
    });

    return () => controller.abort();
  }, [textObservations, service, timeRange]);

  const extractedSeries = extractions.flatMap(e => e.series);
  // Deduplicate series by query — a single query_prometheus call can return multiple
  // series (one per instance/CPU core). Show one chart per unique query.
  const rawSeries = [...timeSeries, ...extractedSeries];
  const seenQueries = new Set<string>();
  const allSeries = rawSeries.filter(ts => {
    const key = ts.query || ts.metric || JSON.stringify(ts.values.slice(0, 2));
    if (seenQueries.has(key)) return false;
    seenQueries.add(key);
    return true;
  });
  // Split "empty after extraction" from network failures. If the extraction
  // succeeded but returned zero series (Prometheus has no data for the metric,
  // or the LLM wrote a metric name that doesn't exist), render an empty-chart
  // placeholder card instead of demoting to a plain text fallback — keeps the
  // visual layout consistent with real charts.
  const emptyExtractions = extractions.filter(e => !e.loading && !e.failed && e.series.length === 0);
  const networkFailed = extractions.filter(e => !e.loading && e.failed).map(e => e.text);
  const overflowTexts = textObservations.slice(MAX_EXTRACTIONS);
  const remainingTexts = [...networkFailed, ...overflowTexts];
  const isExtracting = extractions.some(e => e.loading);

  // Use the shared extractor so the empty-card title matches what the server
  // actually queried (no drift possible, single source of truth).
  const titleFromText = (text: string): string =>
    extractMetricExpression(text) ?? text.slice(0, 60);

  const hasStructured = (structuredObservations?.length ?? 0) > 0;

  if (
    allSeries.length === 0 &&
    !isExtracting &&
    remainingTexts.length === 0 &&
    emptyExtractions.length === 0 &&
    !hasStructured
  ) {
    return <p className="text-xs text-muted-foreground/65 py-4 text-center font-mono">No metric data collected</p>;
  }

  return (
    <div className="space-y-2">
      {allSeries.length > 0 && (
        <div className="grid grid-cols-1 @[500px]:grid-cols-2 gap-2">
          {allSeries.map((ts, i) => {
            const chartUrl = buildChartUrl && ts.query ? buildChartUrl(ts.query) : undefined;
            return (
              <div key={`ts-${i}`} className="relative group">
                <MetricChart series={ts} />
                {chartUrl && (
                  <a
                    href={chartUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="absolute top-1 right-1 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity text-primary/50 hover:text-primary hover:bg-primary/10"
                    aria-label="Open this query in Grafana Explore"
                    title="Open in Grafana"
                  >
                    <ExternalLink size={11} />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}

      {isExtracting && (
        <div className="grid grid-cols-1 @[500px]:grid-cols-2 gap-2">
          {extractions.filter(e => e.loading).map((_, i) => (
            <Skeleton key={`shim-${i}`} className="h-[160px] rounded-lg" />
          ))}
        </div>
      )}

      {/* Empty-chart cards: extraction ran but Prometheus had no data. Keeps
          the visual slot so the observation isn't hidden as a text fallback. */}
      {emptyExtractions.length > 0 && (
        <div className="grid grid-cols-1 @[500px]:grid-cols-2 gap-2">
          {emptyExtractions.map((e, i) => {
            const title = titleFromText(e.text);
            // Only show the footer when it carries extra context beyond the
            // title (e.g., metric expression as title + the baseline/timestamp
            // narrative as footer). For plain observations where title == full
            // text, showing both duplicates the content.
            const showFooter = title !== e.text && !e.text.startsWith(title);
            return (
              <div
                key={`empty-${i}`}
                className="rounded-lg border border-border/25 bg-card/20 px-3.5 py-3 h-[160px] flex flex-col"
                title={e.text}
              >
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                  <span className="font-mono text-[11px] text-foreground/60 truncate">
                    {title}
                  </span>
                </div>
                <div className="flex-1 flex items-center justify-center">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/50">
                    no data
                  </span>
                </div>
                {showFooter && (
                  <p className="font-mono text-[9px] text-muted-foreground/55 leading-relaxed line-clamp-2">
                    {e.text}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Structured metric observation cards */}
      {structuredObservations?.map((obs, i) => (
        <div key={`struct-${i}`} className="rounded-lg border border-border/25 bg-card/30 px-3.5 py-2.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-foreground/70">{obs.metric}</span>
            {obs.severity && <Badge variant={obs.severity === "critical" ? "destructive" : "secondary"} className="text-[10px]">{obs.severity}</Badge>}
          </div>
          <div className="flex items-center gap-3 mt-1.5">
            <span className="text-[11px] font-mono text-primary/70">{obs.currentValue}</span>
            <span className="text-[10px] text-muted-foreground/60">/</span>
            <span className="text-[11px] font-mono text-muted-foreground/70">baseline {obs.baselineValue}</span>
          </div>
        </div>
      ))}

      {remainingTexts.map((text, i) => (
        <div key={`text-${i}`} className="rounded-lg border border-border/25 bg-card/30 px-3.5 py-2.5">
          <p className="font-mono text-xs text-foreground/70 leading-relaxed whitespace-pre-wrap">{text}</p>
        </div>
      ))}
    </div>
  );
}

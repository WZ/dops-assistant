import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowLeft, FilePlus, RotateCw, ChevronDown, Download, Link2, FileText, Image as ImageIcon, ClipboardCopy, Check } from "lucide-react";
import { PhaseStepper, type PhaseState } from "./PhaseStepper";
import { EvidenceTimeline } from "./EvidenceTimeline";
import { RcaReport } from "./RcaReport";
import { OrchestratorRefinedBanner } from "./OrchestratorRefinedBanner";
import { useOrchestratorRun } from "../contexts/OrchestratorRunContext";
import { useInvestigationRunHydration } from "../hooks/useInvestigationRunHydration";
import { InvestigationFeedback } from "./InvestigationFeedback";
import { useStackContext } from "../contexts/StackContext";
import { useGrafanaProviders } from "../hooks/useGrafanaProviders";
import { useUnreadInvestigations } from "../hooks/useUnreadInvestigations";
import type { TimelineEvent } from "./ActivityTimeline";
import type { TimeSeriesData } from "./MetricChart";
import type { ServerMessage } from "../../types/ws-types.js";
import type { RcaReport as RcaReportType } from "../../types/rca-types.js";
import { formatTokens } from "../lib/formatTokens.js";
import { buildPhaseActions } from "../lib/grafana-links.js";
import { downloadMarkdown, downloadPng, copyMarkdown } from "../lib/exportInvestigation.js";
import { confidencePercent } from "../../lib/confidence.js";

const DEFAULT_PHASES: PhaseState[] = [
  { name: "planning", label: "Planning", status: "pending" },
  { name: "metrics", label: "Metrics", status: "pending" },
  { name: "logs", label: "Logs", status: "pending" },
  { name: "infra", label: "Infrastructure", status: "pending" },
  { name: "synthesis", label: "Synthesis", status: "pending" },
];

interface ExportMenuProps {
  report: RcaReportType;
  service: string;
  reportRef: React.RefObject<HTMLDivElement | null>;
  onSaveAsSkill: () => void;
}

function ExportMenu({ report, service, reportRef, onSaveAsSkill }: ExportMenuProps) {
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState<"link" | "md" | null>(null);

  const flashCopied = (key: "link" | "md") => {
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
  };

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href)
      .then(() => flashCopied("link"))
      .catch(() => {});
  };

  const doCopyMarkdown = () => {
    copyMarkdown(report)
      .then(() => flashCopied("md"))
      .catch(() => {});
  };

  const doDownloadMarkdown = () => {
    downloadMarkdown(report, service);
  };

  const doDownloadPng = async () => {
    const node = reportRef.current;
    if (!node) return;
    setBusy(true);
    try {
      await downloadPng(node, service);
    } catch (err) {
      console.error("PNG export failed", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          disabled={busy}
          className="h-9 px-4 text-[12px] font-mono border-primary/30 text-primary/70 hover:bg-primary/8 hover:text-primary rounded-lg gap-1.5"
          title="Export this investigation"
        >
          <Download size={12} className="!size-auto" />
          {busy ? "Exporting…" : "Export"}
          <ChevronDown size={10} className="!size-auto opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); copyLink(); }}
          className="font-mono text-[11px] gap-2"
        >
          {copiedKey === "link" ? (
            <Check size={11} className="!size-auto text-success" />
          ) : (
            <Link2 size={11} className="!size-auto" />
          )}
          {copiedKey === "link" ? "Copied" : "Copy link"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); doCopyMarkdown(); }}
          className="font-mono text-[11px] gap-2"
        >
          {copiedKey === "md" ? (
            <Check size={11} className="!size-auto text-success" />
          ) : (
            <ClipboardCopy size={11} className="!size-auto" />
          )}
          {copiedKey === "md" ? "Copied" : "Copy markdown"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={doDownloadPng} className="font-mono text-[11px] gap-2">
          <ImageIcon size={11} className="!size-auto" />
          Download as PNG
        </DropdownMenuItem>
        <DropdownMenuItem onClick={doDownloadMarkdown} className="font-mono text-[11px] gap-2">
          <FileText size={11} className="!size-auto" />
          Download as Markdown
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSaveAsSkill} className="font-mono text-[11px] gap-2">
          <FilePlus size={11} className="!size-auto" />
          Save as Skill
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


export function InvestigationPane({
  investigationId,
  wsMessages,
  onBack,
  onNavigateSkills,
  onRerun,
  onWrongStack,
}: {
  investigationId: string;
  wsMessages: ServerMessage[];
  onBack: () => void;
  onNavigateSkills?: () => void;
  onRerun?: (investigationId: string, template?: string) => void;
  /** Called when the investigation 404s in the active stack but the locate
   *  endpoint reports it lives in a different stack. The parent should
   *  switchStack + navigate to the correct stack-scoped URL — keeps
   *  hand-edited or rename-stale links resolving instead of dead-ending
   *  on "not found" when the id genuinely exists somewhere. */
  onWrongStack?: (correctStackId: string) => void;
}) {
  const { stackFetch, activeStackId } = useStackContext();
  const { markViewed } = useUnreadInvestigations();
  const [phases, setPhases] = useState<PhaseState[]>(DEFAULT_PHASES);
  const [evidence, setEvidence] = useState<Record<string, unknown>>({});
  const [report, setReport] = useState<unknown | null>(null);
  // Deep-mode + orchestrator run state now lives in the shared run registry
  // (OrchestratorRunContext) so the Console inline surface and this pane read one
  // source of truth. Derive the former local vars from the registry's tagged run.
  const run = useOrchestratorRun(investigationId);
  // GET + legacy-redirect + hydrate + subscribe now live in the shared hook
  // (PR-2d, T3) so this pane and the wide Deep panel reattach identically.
  const deepRun = run?.kind === "deep-mode" ? run : undefined;
  const orchRun = run?.kind === "orchestrator" ? run : undefined;
  // The deep/orchestrator run now renders solely in the Console (InlineRunRegion);
  // this pane keeps only the run's error to surface a failure banner below the report.
  const deepModeError = deepRun?.error ?? null;
  const orchError = orchRun?.error ?? null;
  const [service, setService] = useState("");
  const [query, setQuery] = useState("");
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [phaseTokens, setPhaseTokens] = useState<Record<string, { inputTokens: number; outputTokens: number }>>({});
  const [totalUsage, setTotalUsage] = useState<{ inputTokens: number; outputTokens: number; durationMs: number } | null>(null);
  const providers = useGrafanaProviders();
  const [phaseSwoop, setPhaseSwoop] = useState(false);
  const [investigationStatus, setInvestigationStatus] = useState<"running" | "complete" | "failed" | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const prevRunningRef = useRef(false);
  const processedCount = useRef(0);
  const reportRef = useRef<HTMLDivElement>(null);

  // Providers for Grafana deep links — shared hook (PR-3), stack-aware.

  // Scroll RCA report into center view when it appears
  useEffect(() => {
    if (report && reportRef.current) {
      reportRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [report]);

  // Mark this investigation as viewed for the unread-tracking system. Fires on
  // mount and again whenever the status transitions to a terminal state — that
  // way an investigation the user kicked off from chat, watched live, and waited
  // out won't keep glowing as NEW on the chat RCA card or the Investigation Log
  // row in Operations Desk after they navigate away.
  useEffect(() => {
    markViewed(investigationId);
  }, [investigationId, investigationStatus, markViewed]);

  // Trigger phase swoop animation on the running → complete transition.
  // Update prevRunningRef *before* the early return so the effect doesn't
  // replay the animation on any subsequent phases update after completion.
  useEffect(() => {
    const running = phases.some((p) => p.status === "running");
    const justCompleted = prevRunningRef.current && !running && !!report;
    prevRunningRef.current = running;
    if (justCompleted) {
      setPhaseSwoop(true);
      const t = setTimeout(() => setPhaseSwoop(false), 600);
      return () => clearTimeout(t);
    }
  }, [phases, report]);

  // Determine if this investigation is active (has WS messages) or historical
  const isActive = wsMessages.some(
    (m) => (m.type === "investigation:started" && m.id === investigationId) ||
           (m.type === "investigation:complete" && m.id === investigationId),
  );

  // Fetch query from REST when not available from WS (e.g. server predates query field)
  useEffect(() => {
    if (query) return;
    let cancelled = false;
    stackFetch(`/api/investigations/${investigationId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: { investigation?: { query?: string } } | null) => {
        if (!cancelled && data?.investigation?.query) setQuery(data.investigation.query);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [investigationId, query]);

  // Cold-load the historical investigation + reattach its Deep run (PR-2d, T3):
  // the shared hook owns the GET, the legacy-stack /locate redirect, hydrate, and
  // subscribe — the same path the wide Deep panel uses. Skipped when a live run
  // is streaming here (isActive).
  const { data: hydrationData, notFound } = useInvestigationRunHydration(investigationId, {
    active: isActive,
    onWrongStack,
  });

  // Shape this pane's local UI state (phases / evidence / report / timeline) from
  // the hook's payload. The hook already performed hydrate + subscribe; this just
  // maps the REST data into the detail-page surfaces.
  useEffect(() => {
    if (!hydrationData) return;
    const { investigation, phases: phaseRows, events } = hydrationData;
    setService(investigation.service);
    if (investigation.query) setQuery(investigation.query);

    if (investigation.total_input_tokens && investigation.total_input_tokens > 0) {
      setTotalUsage({
        inputTokens: investigation.total_input_tokens,
        outputTokens: investigation.total_output_tokens ?? 0,
        durationMs: investigation.total_duration_ms ?? 0,
      });
    }

    setInvestigationStatus(investigation.status as "running" | "complete" | "failed");

    const phaseMap = new Map(phaseRows.map((p) => [p.phase, p]));
    setPhases(DEFAULT_PHASES.map((dp) => {
      const stored = phaseMap.get(dp.name);
      if (stored) return { ...dp, status: stored.status as PhaseState["status"] };
      if (investigation.status === "complete") return { ...dp, status: "complete" as const };
      return dp;
    }));

    const evidenceData: Record<string, unknown> = {};
    for (const p of phaseRows) {
      if (p.findings) {
        try { evidenceData[p.phase] = JSON.parse(p.findings); } catch { /* ignore */ }
      }
    }
    if (investigation.report) {
      try {
        const rpt = JSON.parse(investigation.report);
        if (rpt.evidence) {
          if (rpt.evidence.metrics?.length && !evidenceData["metrics"]) evidenceData["metrics"] = { observations: rpt.evidence.metrics };
          if (rpt.evidence.logs?.length && !evidenceData["logs"]) evidenceData["logs"] = { observations: rpt.evidence.logs };
          if (rpt.evidence.infra?.length && !evidenceData["infra"]) evidenceData["infra"] = { observations: rpt.evidence.infra };
        }
      } catch { /* ignore */ }
    }
    if (Object.keys(evidenceData).length > 0) setEvidence(evidenceData);

    if (investigation.report) {
      try { setReport(JSON.parse(investigation.report)); } catch { /* ignore */ }
    }

    if (events && events.length > 0) {
      const restored: TimelineEvent[] = [];
      for (const row of events) {
        try {
          const payload = JSON.parse(row.payload);
          const ts = new Date(row.created_at).getTime();
          if (payload.type === "investigation:tool_call") {
            restored.push({ type: "tool_call", phase: payload.phase, tool: payload.tool, args: payload.args ?? {}, status: payload.status, result: payload.result, durationMs: payload.durationMs, timestamp: ts });
          } else if (payload.type === "investigation:iteration") {
            restored.push({ type: "iteration", phase: payload.phase, iteration: payload.iteration, maxIterations: payload.maxIterations, description: payload.description, timestamp: ts });
          } else if (payload.type === "investigation:phase") {
            restored.push({ type: "phase_change", phase: payload.phase, status: payload.status, stats: payload.stats ? { toolCalls: payload.stats.toolCalls, iterations: payload.stats.iterations, durationMs: payload.stats.durationMs } : undefined, timestamp: ts });
          }
        } catch { /* ignore */ }
      }
      if (restored.length > 0) setTimelineEvents(restored);
    }
  }, [hydrationData]);

  // Process live WebSocket messages
  useEffect(() => {
    const newMessages = wsMessages.slice(processedCount.current);
    processedCount.current = wsMessages.length;

    for (const msg of newMessages) {
      if (msg.type === "investigation:started" && msg.id === investigationId) {
        setService(msg.service);
        setQuery(msg.query);
        setPhases([...DEFAULT_PHASES]);
        setEvidence({});
        setReport(null);
        setTimelineEvents([]);
      }
      if (msg.type === "investigation:phase" && msg.id === investigationId) {
        setPhases((prev) => prev.map((p) =>
          p.name === msg.phase ? { ...p, status: msg.status as PhaseState["status"], substatus: undefined, stats: msg.stats } : p,
        ));
        if (msg.status === "complete" && msg.data) {
          setEvidence((prev) => ({ ...prev, [msg.phase]: msg.data }));
        }
        setTimelineEvents((prev) => [...prev, {
          type: "phase_change" as const,
          phase: msg.phase,
          status: msg.status as "running" | "complete" | "failed",
          stats: msg.stats ? { toolCalls: msg.stats.toolCalls, iterations: msg.stats.iterations, durationMs: msg.stats.durationMs } : undefined,
          timestamp: Date.now(),
        }]);
      }
      if (msg.type === "investigation:tool_call" && msg.id === investigationId) {
        setTimelineEvents((prev) => [...prev, {
          type: "tool_call",
          phase: msg.phase,
          tool: msg.tool,
          args: msg.args,
          status: msg.status,
          result: msg.result,
          durationMs: msg.durationMs,
          timestamp: Date.now(),
        }]);
      }
      if (msg.type === "investigation:iteration" && msg.id === investigationId) {
        setTimelineEvents((prev) => [...prev, {
          type: "iteration",
          phase: msg.phase,
          iteration: msg.iteration,
          maxIterations: msg.maxIterations,
          description: msg.description,
          timestamp: Date.now(),
        }]);
      }
      if (msg.type === "investigation:progress" && msg.id === investigationId) {
        setPhases((prev) => prev.map((p) =>
          p.name === msg.phase ? { ...p, substatus: msg.step } : p,
        ));
      }
      if (msg.type === "investigation:phase_usage" && msg.investigationId === investigationId) {
        setPhaseTokens((prev) => ({
          ...prev,
          [msg.phase]: { inputTokens: msg.inputTokens, outputTokens: msg.outputTokens },
        }));
      }
      if (msg.type === "investigation:total_usage" && msg.investigationId === investigationId) {
        setTotalUsage({ inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, durationMs: msg.durationMs });
      }
      if (msg.type === "investigation:failed" && msg.id === investigationId) {
        setInvestigationStatus("failed");
        if (typeof msg.error === "string" && msg.error.trim().length > 0) {
          setFailureMessage(msg.error);
        }
      }
      if (msg.type === "investigation:complete" && msg.id === investigationId) {
        setInvestigationStatus("complete");
        setReport(msg.report);
        const rpt = msg.report as Record<string, unknown> | null;
        if (rpt?.evidence) {
          const ev = rpt.evidence as Record<string, unknown>;
          setEvidence((prev) => {
            const updated = { ...prev };
            if (Array.isArray(ev.metrics) && ev.metrics.length > 0 && !updated["metrics"]) {
              updated["metrics"] = { observations: ev.metrics };
            }
            if (Array.isArray(ev.logs) && ev.logs.length > 0 && !updated["logs"]) {
              updated["logs"] = { observations: ev.logs };
            }
            if (Array.isArray(ev.infra) && ev.infra.length > 0 && !updated["infra"]) {
              updated["infra"] = { observations: ev.infra };
            }
            return updated;
          });
        }
      }
      // Deep-mode + orchestrator live run state is owned by the run registry
      // (OrchestratorRunContext). This pane only still reacts to deep_mode:complete,
      // to refresh the rendered report snapshot (report.deepMode is persisted and
      // rendered here, independent of the live stream).
      if (msg.type === "deep_mode:complete" && msg.investigationId === investigationId) {
        setReport(msg.report);
      }
      // PR-6b: the operator applied a confirmed deep run's conclusion back into
      // the report. The server persisted the refined report and echoed it here —
      // swap the rendered snapshot so the refined root cause + the "Refined by
      // deep investigation (was: …)" banner appear without a reload.
      if (msg.type === "orchestrator:accepted" && msg.investigationId === investigationId) {
        setReport(msg.report);
      }
    }
  }, [wsMessages, investigationId]);

  const isRunning = phases.some((p) => p.status === "running");
  const isComplete = !!report;

  // Extract time-series data from query_prometheus tool call results
  const timeSeries = useMemo<TimeSeriesData[]>(() => {
    const series: TimeSeriesData[] = [];
    for (const evt of timelineEvents) {
      if (evt.type !== "tool_call" || evt.tool !== "query_prometheus" || evt.status !== "success" || !evt.result) continue;
      try {
        const parsed = JSON.parse(evt.result);
        const items = parsed?.data ?? parsed;
        if (!Array.isArray(items)) continue;
        // Try common parameter names for the PromQL expression
        const a = evt.args ?? {};
        const query = typeof a.query === "string" ? a.query
          : typeof a.expr === "string" ? a.expr
          : typeof a.expression === "string" ? a.expression
          : undefined;
        for (const item of items) {
          if (item.values && Array.isArray(item.values) && item.values.length >= 2) {
            series.push({
              metric: item.m || "",
              instance: item.instance,
              query,
              values: item.values.map(([ts, v]: [string, string | number]) => [ts, typeof v === "string" ? parseFloat(v) : v]),
              min: item.min != null ? parseFloat(item.min) : undefined,
              max: item.max != null ? parseFloat(item.max) : undefined,
              avg: item.avg != null ? parseFloat(item.avg) : undefined,
            });
          }
        }
      } catch { /* ignore unparseable results */ }
    }
    return series;
  }, [timelineEvents]);

  const hasEvidence = Object.keys(evidence).length > 0 || timeSeries.length > 0;

  // Invalid ID, or valid ID but belongs to a different stack: show a clear
  // not-found state instead of the empty Phases skeleton. Active investigations
  // take precedence — if WS messages are still flowing for this id we're
  // mid-run and the REST 404 is expected until persistence catches up.
  if (notFound && !isActive) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="font-mono text-sm uppercase tracking-[0.12em] text-foreground/80">
          Investigation not found
        </h2>
        <p className="font-mono text-[11px] text-muted-foreground/70 max-w-md">
          <code className="text-foreground/60">{investigationId}</code> isn&apos;t in this stack.
          It may belong to a different stack, or it may have been deleted.
        </p>
        <button
          className="mt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-primary hover:text-primary/80"
          onClick={onBack}
        >
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border/40 flex items-center justify-between shrink-0">
        <Button
          variant="ghost"
          onClick={onBack}
          className="h-auto px-0 py-0 text-xs font-mono text-muted-foreground/60 hover:text-primary hover:bg-transparent transition-colors group"
        >
          <ArrowLeft size={12} className="!size-auto group-hover:-translate-x-0.5 transition-transform" />
          back
        </Button>
        <div className="flex items-center gap-3">
          {service && (
            <>
              <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-primary animate-status-pulse" : "bg-success"}`} />
              <span className="text-sm font-mono font-medium text-foreground/70">{service}</span>
            </>
          )}
          {isRunning && (
            <span className="text-[10px] font-mono text-primary/60 uppercase tracking-[0.12em]">investigating...</span>
          )}
          {isComplete && report && (
            <ExportMenu
              report={report as RcaReportType}
              service={service}
              reportRef={reportRef}
              onSaveAsSkill={async () => {
                try {
                  const rpt = report as Record<string, unknown>;
                  const res = await stackFetch("/api/skills/generate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(rpt),
                  });
                  if (!res.ok) return;
                  const generated = await res.json();
                  await stackFetch("/api/skills", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(generated),
                  });
                  onNavigateSkills?.();
                } catch { /* ignore */ }
              }}
            />
          )}
          {isComplete && onRerun && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  disabled={isRunning}
                  className="h-9 px-4 text-[12px] font-mono border-primary/30 text-primary/70 hover:bg-primary/8 hover:text-primary rounded-lg gap-1.5"
                >
                  <RotateCw size={12} className="!size-auto" />
                  Re-investigate
                  <ChevronDown size={10} className="!size-auto opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuItem onClick={() => onRerun(investigationId)} className="font-mono text-[11px]">
                  Re-run (current config)
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onRerun(investigationId, "quick")} className="font-mono text-[11px] text-muted-foreground">
                  Quick (metrics only)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRerun(investigationId, "standard")} className="font-mono text-[11px] text-muted-foreground">
                  Standard (metrics + logs)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRerun(investigationId, "full")} className="font-mono text-[11px] text-muted-foreground">
                  Full (all phases)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* The Deep Investigation entry ("Investigate deeply") moved to the
              Console (ChatPane), below the shortcut chips, in PR-6 — it no longer
              lives on the report header. */}
        </div>
      </div>
      {deepModeError && (
        <div className="px-1 pb-2 text-[11px] font-mono text-destructive/80">{deepModeError}</div>
      )}
      {orchError && (
        <div className="px-1 pb-2 text-[11px] font-mono text-destructive/80">{orchError}</div>
      )}

      {/* Progress bar — visible while running */}
      {isRunning && (
        <div className="progress-bar-track shrink-0">
          <div className="progress-bar-fill" />
        </div>
      )}

      {/* Scrollable content — Two-Column Dossier layout */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col lg:flex-row gap-0 min-h-full">

          {/* LEFT RAIL — metadata column */}
          <aside className="w-full lg:w-[300px] shrink-0 lg:border-r border-border/30 px-5 py-6 space-y-6">

            {/* Phase rail — compact summary only once the investigation is complete.
                While running, phases live in the right column so the user can see tool call detail. */}
            {isComplete && (
              <div className={phaseSwoop ? "animate-phase-swoop-left" : ""}>
                <CompactPhaseRail phases={phases} phaseTokens={phaseTokens} />
              </div>
            )}

            {/* Trigger quote */}
            {query && (
              <section>
                <RailLabel>Trigger</RailLabel>
                <p className="text-[12px] font-body italic text-muted-foreground/80 leading-relaxed">
                  &ldquo;{query}&rdquo;
                </p>
              </section>
            )}

            {/* Metadata */}
            {(totalUsage || isComplete) && (
              <section>
                <RailLabel>Metadata</RailLabel>
                <dl className="space-y-1.5 text-[10px] font-mono">
                  {(report as any)?.confidence && (
                    <MetaRow
                      label="confidence"
                      value={`${String((report as any).confidence).toUpperCase()}${(report as any).confidenceScore ? ` · ${confidencePercent((report as any).confidenceScore)}%` : ""}`}
                    />
                  )}
                  {(report as any)?.severity && (
                    <MetaRow label="severity" value={String((report as any).severity).toUpperCase()} />
                  )}
                  {/* Hypothesis loop (Step 2): present only when the synthesis loop
                      ran (N>1). Its presence is the per-investigation proof that
                      this wasn't a single-pass synthesis. */}
                  {(report as any)?.loopOutcome && (
                    <MetaRow
                      label="loop"
                      value={`${String((report as any).loopOutcome).toUpperCase()}${(report as any).hypotheses?.length ? ` · ${(report as any).hypotheses.length} ranked` : ""}`}
                    />
                  )}
                  {/* Deep mode (Step 3): present only when re-examination ran. */}
                  {(report as any)?.deepMode?.outcome && (report as any).deepMode.outcome !== "nothing-to-examine" && (
                    <MetaRow
                      label="deep mode"
                      value={(() => {
                        const dm = (report as any).deepMode;
                        if (dm.outcome === "resurrected-candidate") return `RESURRECTED · ${dm.resurrected?.length ?? 0}`;
                        if (dm.outcome === "confirmation-shaken") return `SHAKEN · ${dm.shaken?.length ?? 0}`;
                        return "HOLDS";
                      })()}
                    />
                  )}
                  {totalUsage && (
                    <>
                      <MetaRow label="duration" value={`${(totalUsage.durationMs / 1000).toFixed(1)}s`} />
                      <MetaRow label="tokens in" value={formatTokens(totalUsage.inputTokens)} />
                      <MetaRow label="tokens out" value={formatTokens(totalUsage.outputTokens)} />
                    </>
                  )}
                </dl>
              </section>
            )}

          </aside>

          {/* RIGHT COLUMN — live phase activity while running, RCA report when complete */}
          <div className="flex-1 min-w-0 px-6 py-6 space-y-6">
            {/* Live phase activity — only while running, hidden once the report lands */}
            {!isComplete && (
              <section>
                <p className="text-[9px] font-mono font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-3">
                  Investigation in progress
                </p>
                <PhaseStepper phases={phases} events={timelineEvents} evidence={evidence} isComplete={isComplete} phaseTokens={phaseTokens} />
              </section>
            )}

            {/* The deep mode / orchestrator run streams in the Console
                (InlineRunRegion), the single home for a deep run — no duplicate
                card here (PR-6). */}

            {investigationStatus === "failed" && !report ? (
              <section className="rounded-lg border border-destructive/30 bg-destructive/5 px-5 py-4 animate-fade-up">
                <div className="flex items-start gap-3">
                  <span className="text-destructive text-base mt-0.5">✕</span>
                  <div className="flex-1">
                    <p className="text-sm font-body font-semibold text-destructive mb-1">Investigation could not run</p>
                    <p className="text-[12px] font-body text-destructive/80 leading-relaxed">
                      {failureMessage ?? "The LLM API was unreachable for this run."}
                      {" "}No root cause analysis was produced.
                      Check Settings &gt; Health, then click Re-investigate to try again.
                    </p>
                  </div>
                </div>
              </section>
            ) : report ? (
              <section ref={reportRef} className="animate-fade-up">
                {/* Refined-by-deep-investigation banner (PR-6b) — shown only after
                    the operator applied a confirmed deep run; the preserved original
                    root cause makes the change visible/reversible. */}
                {(report as any)?.orchestratorRefined && (
                  <OrchestratorRefinedBanner refinement={(report as any).orchestratorRefined} />
                )}
                <RcaReport report={report as any} hideOldDashboardLinks={providers.length > 0} />
                {/* Feedback prompt — only visible once the report has rendered.
                    Before that there's nothing to rate. Closes the Learned
                    Patterns loop: every first-time "useful" vote upserts a
                    pattern row that surfaces on the Ops Desk. */}
                <InvestigationFeedback investigationId={investigationId} />
              </section>
            ) : !isRunning ? (
              <div className="space-y-3">
                <Skeleton className="h-6 w-48 rounded-md" />
                <Skeleton className="h-32 w-full rounded-lg" />
              </div>
            ) : null}

            {/* Evidence */}
            {hasEvidence && (
              <section>
                <EvidenceTimeline
                  evidence={evidence as any}
                  timeSeries={timeSeries}
                  service={service}
                  providers={providers}
                  timeRange={(report as any)?.timeRange}
                  phaseActions={(() => {
                    const rpt = report as any;
                    const tr = rpt?.timeRange;
                    if (!tr || providers.length === 0) return undefined;
                    const { phaseActions: pa } = buildPhaseActions(undefined, providers, service, tr);
                    return pa;
                  })()}
                  evidenceToolCalls={(report as any)?.evidenceToolCalls}
                />
              </section>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

function RailLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[9px] font-mono font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
      {children}
    </p>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground/55">{label}</dt>
      <dd className="text-foreground/80 tabular-nums">{value}</dd>
    </div>
  );
}

function CompactPhaseRail({ phases, phaseTokens }: { phases: PhaseState[]; phaseTokens?: Record<string, { inputTokens: number; outputTokens: number }> }) {
  return (
    <section>
      <RailLabel>Phases</RailLabel>
      <ul className="space-y-0">
        {phases.map((p) => {
          const duration = p.stats?.durationMs != null
            ? p.stats.durationMs < 1000
              ? `${p.stats.durationMs}ms`
              : `${(p.stats.durationMs / 1000).toFixed(1)}s`
            : null;
          const tokens = phaseTokens?.[p.name];
          const tokenTotal = tokens ? tokens.inputTokens + tokens.outputTokens : 0;
          return (
            <li key={p.name} className="flex items-center gap-2 py-1">
              <span className={
                p.status === "complete" ? "w-3 h-3 rounded-full bg-success/80 text-[8px] text-background flex items-center justify-center font-bold" :
                p.status === "failed" ? "w-3 h-3 rounded-full bg-destructive/80 text-[8px] text-background flex items-center justify-center font-bold" :
                p.status === "running" ? "w-3 h-3 rounded-full border border-primary/80 animate-status-pulse" :
                "w-3 h-3 rounded-full border border-border/60"
              }>
                {p.status === "complete" && "\u2713"}
                {p.status === "failed" && "\u2717"}
              </span>
              <span className="text-[12px] font-body text-foreground/75 flex-1">{p.label}</span>
              {duration && (
                <span className="text-[9px] font-mono text-muted-foreground/55 tabular-nums">{duration}</span>
              )}
              {tokenTotal > 0 && (
                <span className="text-[9px] font-mono text-muted-foreground/40 tabular-nums">{formatTokens(tokenTotal)}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

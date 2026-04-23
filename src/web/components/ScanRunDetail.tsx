/**
 * ScanRunDetail — detail page for a single scan run.
 *
 * Fetches `GET /api/scan/runs/:id` and renders the three scan phases
 * (Probe -> Triage -> Investigate) in a sidebar stepper alongside three
 * evidence cards that unpack the run's metadata, triage breakdown, and
 * dispatched investigations. While the run is still `running`, the page
 * polls every 1.5s; once terminal it fetches once and stops. Task 24 will
 * add live WS updates.
 *
 * Cross-stack 404 handling: if the API returns 404 with `expectedStackId`,
 * renders a banner that lets the user jump to the owning stack rather than
 * bouncing to a dead dashboard.
 *
 * Export menu mirrors `InvestigationPane`'s pattern (copy link / markdown /
 * PNG). "Send to Slack" posts to `/api/notifications/scan-run/send`, which
 * is added by Task 26 — until then the button returns 404, which the UI
 * silently swallows. Including it now keeps the Task 26 diff UI-free.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useStackContext } from "../contexts/StackContext";
import { ScanRunPhaseStepper, type ScanPhaseState } from "./ScanRunPhaseStepper";
import { copyLink, copyMarkdown, downloadPng } from "../lib/exportScanRun";

// === Types =============================================================

interface ScanRunApiRun {
  id: string;
  stackId: string;
  trigger: "manual" | "cron";
  status: "running" | "complete" | "failed" | "skipped";
  skipReason: string | null;
  startedAt: number;
  finishedAt: number | null;
  servicesProbed: number;
  rulesApplied: number;
  queriesExecuted: number;
  probeErrors: number;
  probeDurationMs: number | null;
  probeDetailJson: string | null;
  hitsRaw: number;
  hitsAfterDedup: number;
  hitsDispatched: number;
  droppedByCap: number;
  triageDetailJson: string | null;
  errorMessage: string | null;
  createdAt: number;
}

interface ScanRunApiInvestigation {
  scanRunId: string;
  investigationId: string;
  service: string;
  ruleName: string;
  value: number;
  severity: number;
  dispatchedAt: number;
  status: string;
  reportSummary: string | null;
  completedAt: string | null;
}

interface ScanRunData {
  run: ScanRunApiRun;
  investigations: ScanRunApiInvestigation[];
}

interface TriageDetail {
  hits?: Array<{ service: string; ruleName: string; severity: number }>;
  deduped?: Array<{ service: string; ruleName: string; reason: string }>;
  cappedOut?: Array<{ service: string; ruleName: string; severity: number }>;
}

interface Props {
  runId: string;
  onBack: () => void;
  onOpenInvestigation?: (investigationId: string) => void;
  onSwitchStack?: (stackId: string) => void;
}

// === Component =========================================================

export function ScanRunDetail({ runId, onBack, onOpenInvestigation, onSwitchStack }: Props) {
  const { stackFetch } = useStackContext();
  const [data, setData] = useState<ScanRunData | null>(null);
  const [error, setError] = useState<{ status: number; expectedStackId?: string; message: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await stackFetch(`/api/scan/runs/${encodeURIComponent(runId)}`);
        if (!res.ok) {
          let body: { expectedStackId?: string; error?: string } = {};
          try { body = await res.json(); } catch { /* ignore */ }
          if (!cancelled) {
            setError({
              status: res.status,
              expectedStackId: body.expectedStackId,
              message: body.error ?? res.statusText,
            });
          }
          return;
        }
        const json = (await res.json()) as ScanRunData;
        if (!cancelled) {
          setData(json);
          setError(null);
          // Poll while running. Task 24 will replace polling with live WS updates.
          if (json.run.status === "running") {
            timer = setTimeout(() => { void load(); }, 1500);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError({ status: 0, message: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, stackFetch]);

  const phaseStates: ScanPhaseState[] = useMemo(() => {
    if (!data) return [];
    const { run, investigations } = data;
    const probeDone = run.probeDurationMs != null;
    // Triage completes once probe is done AND the run is no longer running (or
    // the run already recorded hit counts). While probe is in flight the triage
    // row stays pending; between probe-done and run-terminal it's running.
    const triageDone = probeDone && run.status !== "running";
    const hasChildren = investigations.length > 0;
    const allChildrenTerminal = hasChildren && investigations.every(
      (i) => i.status === "complete" || i.status === "failed",
    );
    const anyChildRunning = investigations.some(
      (i) => i.status !== "complete" && i.status !== "failed",
    );

    const probeStatus: ScanPhaseState["status"] =
      run.status === "failed" && !probeDone ? "failed"
      : probeDone ? "complete"
      : run.status === "running" ? "running"
      : "pending";

    const triageStatus: ScanPhaseState["status"] =
      triageDone ? "complete"
      : probeDone && run.status === "running" ? "running"
      : "pending";

    // Investigate phase:
    //   - no investigations + run terminal -> complete (nothing to do)
    //   - has investigations + all terminal -> complete
    //   - has investigations + any running -> running
    //   - otherwise pending
    const investigateStatus: ScanPhaseState["status"] =
      !hasChildren && (run.status === "complete" || run.status === "skipped" || run.status === "failed")
        ? "complete"
      : allChildrenTerminal
        ? "complete"
      : anyChildRunning
        ? "running"
        : "pending";

    return [
      {
        phase: "probe",
        status: probeStatus,
        summary: probeDone
          ? `${run.servicesProbed} probed \u00b7 ${run.probeDurationMs}ms`
          : undefined,
      },
      {
        phase: "triage",
        status: triageStatus,
        summary: probeDone
          ? `${run.hitsRaw}\u2192${run.hitsAfterDedup}\u2192${run.hitsDispatched}`
          : undefined,
      },
      {
        phase: "investigate",
        status: investigateStatus,
        summary: hasChildren ? `${investigations.length} dispatched` : undefined,
      },
    ];
  }, [data]);

  // === Render ==========================================================

  if (error) {
    if (error.status === 404 && error.expectedStackId) {
      return (
        <div className="mx-auto max-w-3xl p-6">
          <h2 className="text-lg font-semibold">This scan belongs to a different stack.</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Run belongs to stack{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">{error.expectedStackId}</code>.
          </p>
          <div className="mt-4 flex gap-2">
            {onSwitchStack && (
              <button
                type="button"
                className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                onClick={() => onSwitchStack(error.expectedStackId!)}
              >
                Switch to that stack
              </button>
            )}
            <button
              type="button"
              className="h-9 rounded-lg border border-border/60 px-3 text-sm hover:bg-secondary/40"
              onClick={onBack}
            >
              Back
            </button>
          </div>
        </div>
      );
    }
    if (error.status === 404) {
      return (
        <div className="mx-auto max-w-3xl p-6">
          <h2 className="text-lg font-semibold">Scan run not found</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The run <code className="rounded bg-muted px-1 font-mono text-xs">{runId}</code> doesn&apos;t exist.
          </p>
          <button
            type="button"
            className="mt-4 text-sm text-primary hover:text-primary/80"
            onClick={onBack}
          >
            &larr; Back to dashboard
          </button>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-destructive">
        Failed to load: {error.message}
      </div>
    );
  }

  if (!data) {
    return <div className="p-6 text-sm text-muted-foreground">Loading&hellip;</div>;
  }

  const { run, investigations } = data;

  return (
    <div ref={rootRef} className="mx-auto max-w-5xl p-6">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-primary hover:text-primary/80"
          >
            &larr; Back
          </button>
          <h1 className="mt-1 text-lg font-semibold">
            Scan Run &middot; {new Date(run.startedAt).toLocaleString()}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {run.trigger} &middot; {run.servicesProbed} services probed &middot;{" "}
            <span className={statusTextClass(run.status)}>{run.status}</span>
            {run.skipReason && ` \u00b7 ${run.skipReason}`}
          </p>
        </div>
        <ExportMenu run={run} investigations={investigations} rootRef={rootRef} />
      </header>

      {run.errorMessage && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/8 p-3 text-sm text-destructive">
          {run.errorMessage}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
        <aside className="md:sticky md:top-6 md:self-start">
          <ScanRunPhaseStepper states={phaseStates} />
        </aside>
        <div className="space-y-4">
          <ProbeCard run={run} />
          <TriageCard run={run} />
          <InvestigateCard investigations={investigations} onOpenInvestigation={onOpenInvestigation} />
        </div>
      </div>
    </div>
  );
}

// === Subcomponents ====================================================

function statusTextClass(status: ScanRunApiRun["status"]): string {
  switch (status) {
    case "complete":
      return "text-success";
    case "failed":
      return "text-destructive";
    case "running":
      return "text-primary";
    case "skipped":
    default:
      return "text-muted-foreground";
  }
}

function ProbeCard({ run }: { run: ScanRunApiRun }) {
  const [open, setOpen] = useState(false);
  const detail = run.probeDetailJson ? safeParse(run.probeDetailJson) : null;
  return (
    <section className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h2 className="mb-2 text-sm font-semibold">Probe</h2>
      <p className="text-sm text-foreground/90">
        {run.servicesProbed} services &middot; {run.queriesExecuted} queries &middot;{" "}
        <span className={run.probeErrors > 0 ? "text-warning" : undefined}>
          {run.probeErrors} errors
        </span>
        {run.probeDurationMs != null && ` \u00b7 ${run.probeDurationMs}ms`}
      </p>
      {detail !== null && run.probeErrors > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mt-2 text-xs text-primary hover:text-primary/80"
          >
            {open ? "Hide probe detail" : "Show probe detail"}
          </button>
          {open && (
            <pre className="mt-2 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs text-foreground/80">
              {JSON.stringify(detail, null, 2)}
            </pre>
          )}
        </>
      )}
    </section>
  );
}

function TriageCard({ run }: { run: ScanRunApiRun }) {
  const [open, setOpen] = useState(false);
  const detail = run.triageDetailJson
    ? (safeParse(run.triageDetailJson) as TriageDetail | null)
    : null;
  const dedupedList = detail?.deduped ?? [];
  const cappedList = detail?.cappedOut ?? [];
  const hasBreakdown = dedupedList.length > 0 || cappedList.length > 0;

  return (
    <section className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h2 className="mb-2 text-sm font-semibold">Triage</h2>
      <p className="text-sm text-foreground/90">
        {run.hitsRaw} raw &rarr; {run.hitsAfterDedup} after dedup &rarr;{" "}
        <span className={run.hitsDispatched > 0 ? "text-warning" : undefined}>
          {run.hitsDispatched} dispatched
        </span>
        {run.droppedByCap > 0 && (
          <span className="text-muted-foreground"> ({run.droppedByCap} capped)</span>
        )}
      </p>
      {hasBreakdown && (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mt-2 text-xs text-primary hover:text-primary/80"
          >
            {open ? "Hide breakdown" : "Show breakdown"}
          </button>
          {open && (
            <div className="mt-2 space-y-2 text-xs">
              {dedupedList.length > 0 && (
                <div>
                  <div className="font-semibold text-foreground/85">Deduped:</div>
                  <ul className="ml-4 list-disc text-muted-foreground">
                    {dedupedList.map((d, i) => (
                      <li key={`${d.service}-${d.ruleName}-${i}`}>
                        {d.service} &middot; {d.ruleName} ({d.reason})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {cappedList.length > 0 && (
                <div>
                  <div className="font-semibold text-foreground/85">Capped out:</div>
                  <ul className="ml-4 list-disc text-muted-foreground">
                    {cappedList.map((d, i) => (
                      <li key={`${d.service}-${d.ruleName}-${i}`}>
                        {d.service} &middot; {d.ruleName} (sev {d.severity.toFixed(2)})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function InvestigateCard({
  investigations,
  onOpenInvestigation,
}: {
  investigations: ScanRunApiInvestigation[];
  onOpenInvestigation?: (id: string) => void;
}) {
  return (
    <section className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h2 className="mb-3 text-sm font-semibold">
        Investigate &middot; {investigations.length} dispatched
      </h2>
      <div className="grid gap-2">
        {investigations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No investigations dispatched.</p>
        ) : (
          investigations.map((inv) => (
            <InvestigationMiniCard
              key={inv.investigationId}
              inv={inv}
              onOpen={onOpenInvestigation}
            />
          ))
        )}
      </div>
    </section>
  );
}

function InvestigationMiniCard({
  inv,
  onOpen,
}: {
  inv: ScanRunApiInvestigation;
  onOpen?: (id: string) => void;
}) {
  const color =
    inv.status === "complete"
      ? "text-success"
      : inv.status === "failed"
      ? "text-destructive"
      : "text-primary";
  return (
    <div className="rounded border border-border/40 bg-background/40 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <strong className="text-foreground/95">{inv.service}</strong>
        <span className={`font-mono text-xs ${color}`}>&bull; {inv.status}</span>
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
        {inv.ruleName} &middot; sev {inv.severity.toFixed(2)}
      </div>
      {inv.reportSummary && (
        <p className="mt-1 text-xs text-foreground/80">{inv.reportSummary}</p>
      )}
      {onOpen && (
        <button
          type="button"
          onClick={() => onOpen(inv.investigationId)}
          className="mt-2 text-xs text-primary hover:text-primary/80"
        >
          Full detail &rarr;
        </button>
      )}
    </div>
  );
}

function ExportMenu({
  run,
  investigations,
  rootRef,
}: {
  run: ScanRunApiRun;
  investigations: ScanRunApiInvestigation[];
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const { stackFetch } = useStackContext();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const doCopyLink = async () => {
    try { await copyLink(); } catch { /* ignore */ }
    setOpen(false);
  };

  const doCopyMarkdown = async () => {
    const summaryShape = {
      id: run.id,
      trigger: run.trigger,
      status: run.status,
      startedAt: run.startedAt,
      servicesProbed: run.servicesProbed,
      hitsDispatched: run.hitsDispatched,
      durationMs: run.probeDurationMs,
    };
    const invShape = investigations.map((i) => ({
      investigationId: i.investigationId,
      service: i.service,
      ruleName: i.ruleName,
      status: i.status,
      reportSummary: i.reportSummary,
    }));
    try { await copyMarkdown(summaryShape, invShape); } catch { /* ignore */ }
    setOpen(false);
  };

  const doDownloadPng = async () => {
    if (!rootRef.current) { setOpen(false); return; }
    setBusy(true);
    try {
      await downloadPng(rootRef.current, run.id);
    } catch (err) {
      console.error("PNG export failed", err);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  // NOTE: Task 26 adds `POST /api/notifications/scan-run/send`. Until then
  // this will 404 silently — we swallow non-OK responses so the button
  // lands now and Task 26 is a pure backend diff.
  const doSendToSlack = async () => {
    setBusy(true);
    try {
      await stackFetch("/api/notifications/scan-run/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.id }),
      });
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        className="h-9 rounded-lg border border-border/60 px-3 text-sm hover:bg-secondary/40 disabled:opacity-50"
      >
        {busy ? "Working\u2026" : "\u22ef Export"}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 flex min-w-[180px] flex-col rounded-lg border border-border/60 bg-card p-1 text-sm shadow-md">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-left hover:bg-secondary/40"
            onClick={doCopyLink}
          >
            Copy link
          </button>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-left hover:bg-secondary/40"
            onClick={doCopyMarkdown}
          >
            Copy as Markdown
          </button>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-left hover:bg-secondary/40"
            onClick={doDownloadPng}
          >
            Download PNG
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded px-3 py-1.5 text-left hover:bg-secondary/40 disabled:opacity-50"
            onClick={doSendToSlack}
          >
            Send to Slack
          </button>
        </div>
      )}
    </div>
  );
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

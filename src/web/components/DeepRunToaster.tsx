/**
 * DeepRunToaster (PR-1, task T8) — Console notifications for Deep Investigation
 * runs. A run is multi-minute and nobody watches it the whole time, so when one
 * PAUSES (needs an operator call) or COMPLETES, surface a dismissable toast that
 * jumps back to the run.
 *
 * Driven by registry transitions (not per-step): it diffs the runs map and fires
 * once on running→paused and once on running→finished. Lives at App level inside
 * the OrchestratorRunProvider.
 */
import { useEffect, useRef, useState } from "react";
import { useOrchestratorRuns, type DeepRunState } from "../contexts/OrchestratorRunContext";

type ToastKind = "paused" | "confirmed" | "finished" | "error";

interface DeepToast {
  key: string;
  investigationId: string;
  kind: ToastKind;
  title: string;
  detail: string;
}

const TOAST_MS = 8000;

function terminalToast(run: DeepRunState, id: string): DeepToast | null {
  if (run.error) return { key: `${id}:err`, investigationId: id, kind: "error", title: "Deep Investigation stopped", detail: run.error };
  if (run.outcome === "confirmed") return { key: `${id}:done`, investigationId: id, kind: "confirmed", title: "Root cause confirmed", detail: "Deep Investigation found a cause — click to view." };
  if (run.outcome) return { key: `${id}:done`, investigationId: id, kind: "finished", title: "Deep Investigation finished", detail: "Click to view the result." };
  return null;
}

export function DeepRunToaster({ onView }: { onView?: (investigationId: string) => void }) {
  const runs = useOrchestratorRuns();
  const prev = useRef<Map<string, { running: boolean; paused: boolean }>>(new Map());
  const [toasts, setToasts] = useState<DeepToast[]>([]);

  useEffect(() => {
    const push = (t: DeepToast) => setToasts((cur) => (cur.some((x) => x.key === t.key) ? cur : [...cur.slice(-2), t]));
    for (const [id, run] of runs) {
      const before = prev.current.get(id) ?? { running: false, paused: false };
      const nowPaused = !!run.pause && !run.decisionSubmitted;
      // running → paused (a fresh pause awaiting a decision)
      if (nowPaused && !before.paused) {
        push({ key: `${id}:pause:${run.pause?.strikes}`, investigationId: id, kind: "paused", title: "Deep Investigation paused", detail: "Needs your call — click to decide." });
      }
      // running → finished
      if (before.running && !run.running) {
        const t = terminalToast(run, id);
        if (t) push(t);
      }
      prev.current.set(id, { running: run.running, paused: nowPaused });
    }
  }, [runs]);

  // Auto-dismiss each toast.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => setTimeout(() => setToasts((cur) => cur.filter((x) => x.key !== t.key)), TOAST_MS));
    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[300px]" role="region" aria-label="Deep Investigation notifications">
      {toasts.map((t) => {
        const accent = t.kind === "paused" ? "border-warning/35" : t.kind === "error" ? "border-destructive/35" : "border-success/30";
        const dot = t.kind === "paused" ? "bg-warning" : t.kind === "error" ? "bg-destructive" : "bg-success";
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => { onView?.(t.investigationId); setToasts((cur) => cur.filter((x) => x.key !== t.key)); }}
            className={`text-left rounded-lg border ${accent} bg-card p-3 shadow-lg hover:bg-card/80 transition-colors animate-fade-up`}
          >
            <div className="flex items-start gap-2.5">
              <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${dot}`} />
              <div className="min-w-0">
                <div className="font-sans font-semibold text-[12px] text-foreground/90">{t.title}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{t.detail}</div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// src/web/components/investigation/InvestigationTopStrip.tsx
import type { ReactNode } from "react";
import { PhaseStepper, type PhaseState } from "../PhaseStepper";

interface Props {
  phases: PhaseState[];
  phaseTokens: Record<string, { inputTokens: number; outputTokens: number }>;
  isRunning: boolean;
  isComplete: boolean;
  /** Confidence as an integer 0-100, or null if not scored yet. */
  confidencePct: number | null;
  /** Slot for the ExportMenu from the parent. Kept as a slot to avoid pulling its deps. */
  exportSlot?: ReactNode;
  /** Slot for the Re-investigate dropdown from the parent. */
  rerunSlot?: ReactNode;
}

export function InvestigationTopStrip({
  phases,
  phaseTokens,
  isRunning: _isRunning,
  isComplete,
  confidencePct,
  exportSlot,
  rerunSlot,
}: Props) {
  return (
    <div
      aria-label="Investigation status"
      className="border-b border-border/40 px-5 py-3 flex items-center gap-5 shrink-0"
    >
      <div className="flex-1 min-w-0 overflow-hidden">
        <PhaseStepper phases={phases} phaseTokens={phaseTokens} isComplete={isComplete} />
      </div>
      {confidencePct !== null && (
        <div className="shrink-0 flex flex-col items-end leading-none">
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60 mb-1">
            Confidence
          </span>
          <span className="font-display text-[28px] font-semibold tabular-nums text-foreground">
            {confidencePct}%
          </span>
        </div>
      )}
      {(rerunSlot || exportSlot) && (
        <div className="shrink-0 flex items-center gap-2">
          {rerunSlot}
          {exportSlot}
        </div>
      )}
    </div>
  );
}

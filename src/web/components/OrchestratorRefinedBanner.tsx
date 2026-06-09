/**
 * OrchestratorRefinedBanner (PR-6b) — the "Refined by deep investigation" notice
 * on the wide RCA report. Rendered above the report when an operator applied a
 * confirmed autonomous-orchestrator run's conclusion back into it.
 *
 * The wide report is where the before→after belongs (not the cramped Console):
 * it shows the refined conclusion (now the report's root cause) alongside the
 * preserved original ("was: …"), making the change visible and reversible. Pure
 * presentational projection of the persisted `OrchestratorRefinement` marker.
 */
import type { OrchestratorRefinement } from "../../types/rca-types.js";

export function OrchestratorRefinedBanner({ refinement }: { refinement: OrchestratorRefinement }) {
  const at = refinement.refinedAt ? new Date(refinement.refinedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleString() : null;
  return (
    <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 animate-fade-in" role="status">
      <p className="text-[11px] font-mono font-semibold uppercase tracking-[0.12em] text-primary/90 mb-1">
        ✦ Refined by deep investigation
        {when && (
          <span className="ml-1.5 font-normal normal-case tracking-normal text-muted-foreground/70">· {when}</span>
        )}
      </p>
      <p className="text-[12px] font-body text-foreground/80 leading-relaxed">
        An autonomous deep investigation confirmed this root cause and the operator applied it.
      </p>
      <p className="text-[11.5px] font-body text-muted-foreground/80 leading-relaxed mt-1">
        was:{" "}
        <span className="line-through decoration-muted-foreground/40">
          {refinement.originalRootCause || "—"}
        </span>
      </p>
      {refinement.operatorNotes && (
        <p className="text-[11px] font-body text-muted-foreground/70 leading-relaxed mt-1">
          operator steer: {refinement.operatorNotes}
        </p>
      )}
    </div>
  );
}

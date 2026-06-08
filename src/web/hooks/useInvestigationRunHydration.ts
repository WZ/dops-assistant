/**
 * useInvestigationRunHydration (PR-2d, T3) — the shared cold-load for an
 * investigation's Deep Investigation run, extracted from `InvestigationPane`.
 * PR-6 removed the wide `/deep` panel, so the detail page (Console) is now the
 * only consumer; the hook stays factored out as the single GET / hydrate /
 * subscribe path.
 *
 * Owns, for a non-active (cold-loaded) investigation:
 *   1. GET /api/investigations/:id  → returns the raw payload to the caller
 *      (the detail page shapes service/report plus phases/evidence/timeline).
 *   2. Legacy stack redirect: a 404 in the active stack probes /locate and, if
 *      the id lives elsewhere, calls onWrongStack so the parent re-routes.
 *   3. hydrate(events) — reconstruct a persisted run (renders INTERRUPTED until
 *      a live reattach clears it).
 *   4. subscribe(id) on (re)connect — reattach to a live server-side run
 *      (orchestrator:replay → live, or not_live → the cold render stands).
 *
 *   GET ─▶ 404? ─▶ /locate ─▶ onWrongStack(stack)         (re-route)
 *    │             └─ not found anywhere ─▶ notFound=true
 *    └─ ok ─▶ setData(payload) + hydrate(events)
 *   connected ─▶ subscribe(id)   /   unmount|reconnect ─▶ unsubscribe(id)
 */
import { useEffect, useState } from "react";
import { useStackContext } from "../contexts/StackContext";
import { useOrchestratorRunActions } from "../contexts/OrchestratorRunContext";

/** Raw GET /api/investigations/:id payload (snake_case from the DB layer). */
export interface InvestigationPayload {
  investigation: {
    service: string;
    query: string;
    status: string;
    report: string | null;
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_duration_ms?: number;
  };
  phases: Array<{ phase: string; status: string; findings: string | null }>;
  events?: Array<{ event_type: string; payload: string; created_at: string }>;
}

export interface InvestigationRunHydration {
  /** The fetched investigation payload (null until the GET resolves / when active). */
  data: InvestigationPayload | null;
  /** True when the id doesn't exist in this stack and /locate found no other home. */
  notFound: boolean;
}

/**
 * @param investigationId  the id to load
 * @param opts.active      true when a LIVE run is streaming in this session for
 *   this id (the cold GET is skipped — live state is authoritative). The detail
 *   page passes its `isActive`; the panel passes false (it's always a cold/deep
 *   surface).
 * @param opts.onWrongStack called with the owning stackId when the id lives in a
 *   different stack, so the parent can re-route.
 */
export function useInvestigationRunHydration(
  investigationId: string,
  opts: { active: boolean; onWrongStack?: (correctStackId: string) => void },
): InvestigationRunHydration {
  const { active, onWrongStack } = opts;
  const { stackFetch, activeStackId } = useStackContext();
  const { hydrate, subscribe, unsubscribe, connectionStatus } = useOrchestratorRunActions();
  const [data, setData] = useState<InvestigationPayload | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Cold-load: GET + legacy stack redirect + hydrate. Skipped when a live run is
  // already streaming here (active). Re-runs after a stack switch (activeStackId).
  useEffect(() => {
    if (active) return;
    let cancelled = false;
    setNotFound(false);
    stackFetch(`/api/investigations/${investigationId}`)
      .then(async (r) => {
        if (r.status === 404) {
          // Wrong stack scope? Probe the stack-agnostic locate endpoint; if the
          // id lives elsewhere, ask the parent to switch + re-route. Otherwise
          // it genuinely doesn't exist → notFound.
          try {
            const lr = await stackFetch(`/api/investigations/${investigationId}/locate`);
            if (cancelled) return null;
            if (lr.ok) {
              const ld = (await lr.json()) as { stackId?: string };
              if (ld?.stackId && ld.stackId !== activeStackId && onWrongStack) {
                onWrongStack(ld.stackId);
                return null;
              }
            }
          } catch { /* fall through to notFound */ }
          if (!cancelled) setNotFound(true);
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<InvestigationPayload>;
      })
      .then((payload: InvestigationPayload | null) => {
        if (cancelled || !payload) return;
        setData(payload);
        // Reconstruct a persisted orchestrator run (hydrate-if-absent, filters to
        // orchestrator:* internally) so passing the full events array is safe.
        if (payload.events && payload.events.length > 0) {
          hydrate(investigationId, payload.events);
        }
      })
      .catch(() => { /* silently fail — the surface renders its empty/error state */ });
    return () => { cancelled = true; };
  }, [investigationId, active, stackFetch, activeStackId, onWrongStack, hydrate]);

  // Reattach to a live server-side run on (re)connect. Re-runs when
  // connectionStatus flips so a dropped socket reattaches automatically. The
  // replay reducer is race-safe, so a redundant subscribe is harmless.
  useEffect(() => {
    if (!investigationId || connectionStatus !== "connected") return;
    subscribe(investigationId);
    return () => unsubscribe(investigationId);
  }, [investigationId, connectionStatus, subscribe, unsubscribe]);

  return { data, notFound };
}

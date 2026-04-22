/**
 * scan-run-store — lifecycle handle for a single scan tick.
 *
 * ScanScheduler.tick() calls begin() at the start, then recordProbeComplete,
 * recordTriageComplete, linkInvestigation (0..N), and exactly one of
 * finalize/skip/fail. Each method does one SQL write + one WS emit (the
 * emit is a no-op when no trigger connection exists — cron ticks).
 *
 * onComplete hook fires only on successful finalize("complete") and is
 * consumed by StackManager to trigger notifications + event-log entries.
 */

import { ulid } from "ulid";
import { createLogger } from "../logger.js";
import type { Database } from "./db.js";

const logger = createLogger();

export type ProbeHitLite = {
  service: string;
  ruleName: string;
  value: number;
  severity: number;
};

export interface ProbeStats {
  servicesProbed: number;
  rulesApplied: number;
  queriesExecuted: number;
  probeErrors: number;
  durationMs: number;
  detail?: unknown; // JSON-serializable; errors, slow queries, etc.
}

export interface TriageDetail {
  hitsRaw: number;
  hitsAfterDedup: number;
  dispatched: ProbeHitLite[];
  dropped: ProbeHitLite[];
  dedupedList: Array<ProbeHitLite & { reason: "recently_investigated"; sinceMs?: number }>;
}

export type ScanEvent =
  | { type: "scan:started"; runId: string; stackId: string; trigger: "manual" | "cron"; startedAt: number }
  | { type: "scan:probe_complete"; runId: string; stackId: string; stats: Omit<ProbeStats, "detail"> }
  | { type: "scan:triage_complete"; runId: string; stackId: string; detail: TriageDetail }
  | { type: "scan:investigation_dispatched"; runId: string; stackId: string; investigationId: string; service: string; ruleName: string }
  | { type: "scan:complete"; runId: string; stackId: string; status: "complete"; durationMs: number; hitsDispatched: number }
  | { type: "scan:failed"; runId: string; stackId: string; error: string }
  | { type: "scan:skipped"; runId: string; stackId: string; reason: string };

export interface ScanRunCompletedSummary {
  runId: string;
  stackId: string;
  trigger: "manual" | "cron";
  startedAt: number;
  durationMs: number;
  servicesProbed: number;
  hitsDispatched: number;
  dispatchedServices: string[];
}

export interface ScanRunTracker {
  readonly id: string;
  readonly stackId: string;
  recordProbeComplete(stats: ProbeStats): void;
  recordTriageComplete(detail: TriageDetail): void;
  linkInvestigation(investigationId: string, hit: ProbeHitLite): void;
  finalize(status: "complete"): void;
  skip(reason: string): void;
  fail(err: unknown): void;
}

export interface ScanRunStore {
  begin(args: { stackId: string; trigger: "manual" | "cron" }): ScanRunTracker;
}

export interface ScanRunStoreDeps {
  db: Database;
  emit?: (evt: ScanEvent) => void;
  onComplete?: (summary: ScanRunCompletedSummary) => void;
}

export function createScanRunStore(deps: ScanRunStoreDeps): ScanRunStore {
  return {
    begin({ stackId, trigger }) {
      const id = ulid();
      const startedAt = Date.now();
      deps.db.insertScanRun({ id, stackId, trigger, startedAt });
      deps.emit?.({ type: "scan:started", runId: id, stackId, trigger, startedAt });

      let terminated = false;
      let servicesProbed = 0;
      const dispatchedServices: string[] = [];
      let hitsDispatched = 0;

      function terminate(op: string, fn: () => void): void {
        if (terminated) {
          logger.warn({ runId: id, op }, "scan-run: ignored duplicate terminal call");
          return;
        }
        terminated = true;
        fn();
      }

      return {
        id,
        stackId,
        recordProbeComplete(stats) {
          servicesProbed = stats.servicesProbed;
          deps.db.updateScanRun(id, {
            servicesProbed: stats.servicesProbed,
            rulesApplied: stats.rulesApplied,
            queriesExecuted: stats.queriesExecuted,
            probeErrors: stats.probeErrors,
            probeDurationMs: stats.durationMs,
            probeDetailJson: stats.detail !== undefined ? JSON.stringify(stats.detail) : undefined,
          });
          const { detail: _detail, ...rest } = stats;
          deps.emit?.({ type: "scan:probe_complete", runId: id, stackId, stats: rest });
        },
        recordTriageComplete(detail) {
          deps.db.updateScanRun(id, {
            hitsRaw: detail.hitsRaw,
            hitsAfterDedup: detail.hitsAfterDedup,
            hitsDispatched: detail.dispatched.length,
            droppedByCap: detail.dropped.length,
            triageDetailJson: JSON.stringify({
              hits: detail.dispatched,
              deduped: detail.dedupedList,
              cappedOut: detail.dropped,
            }),
          });
          deps.emit?.({ type: "scan:triage_complete", runId: id, stackId, detail });
        },
        linkInvestigation(investigationId, hit) {
          deps.db.linkScanRunInvestigation(id, investigationId, {
            service: hit.service,
            ruleName: hit.ruleName,
            value: hit.value,
            severity: hit.severity,
            dispatchedAt: Date.now(),
          });
          dispatchedServices.push(hit.service);
          hitsDispatched += 1;
          deps.emit?.({
            type: "scan:investigation_dispatched",
            runId: id, stackId, investigationId,
            service: hit.service, ruleName: hit.ruleName,
          });
        },
        finalize(status) {
          terminate("finalize", () => {
            const finishedAt = Date.now();
            deps.db.updateScanRun(id, { status, finishedAt });
            const durationMs = finishedAt - startedAt;
            deps.emit?.({
              type: "scan:complete", runId: id, stackId, status,
              durationMs, hitsDispatched,
            });
            deps.onComplete?.({
              runId: id, stackId, trigger,
              startedAt, durationMs,
              servicesProbed, hitsDispatched, dispatchedServices,
            });
          });
        },
        skip(reason) {
          terminate("skip", () => {
            const finishedAt = Date.now();
            deps.db.updateScanRun(id, { status: "skipped", skipReason: reason, finishedAt });
            deps.emit?.({ type: "scan:skipped", runId: id, stackId, reason });
          });
        },
        fail(err) {
          terminate("fail", () => {
            const msg = err instanceof Error ? err.message : String(err);
            const finishedAt = Date.now();
            deps.db.updateScanRun(id, { status: "failed", errorMessage: msg, finishedAt });
            deps.emit?.({ type: "scan:failed", runId: id, stackId, error: msg });
          });
        },
      };
    },
  };
}

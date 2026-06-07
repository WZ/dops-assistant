/**
 * OrchestratorRunRegistry (PR-2c, task T1) — a SERVER-LIFETIME home for in-flight
 * Deep Investigation (orchestrator) runs, decoupling a run from the WebSocket
 * connection that launched it.
 *
 * Before PR-2c, run state (`activeOrchestrations`, `pendingPauses`, `send`) lived
 * per-connection, so a reload/tab-close aborted the run. This registry holds that
 * state once, keyed by investigationId, and lets ANY connection attach/detach a
 * sink to a live run — so a run survives disconnect and a reconnecting client
 * reattaches to the live stream (T3), while a viewerless run auto-parks (T5)
 * instead of burning tokens headless.
 *
 *   launch ─▶ create(id, abort)
 *   tab A  ─▶ attachSink(id, sendA) ┐
 *   tab B  ─▶ attachSink(id, sendB) ┴─▶ broadcast(id, ev) fans out to {A,B}
 *   close A─▶ detachSink(id, sendA)    (run keeps running; B still attached)
 *   no sinks for PARK_IDLE_MS ─▶ requestPark(id) ─▶ loop parks at next checkpoint
 *   reattach ─▶ attachSink + resolvePause(id, "continue")  (cancels pending park)
 *   terminal ─▶ markTerminal(id) ─▶ swept after TERMINAL_GRACE_MS
 *
 * This module is pure state + lifecycle. The move-loop park *checkpoint* (T5) and
 * the WS wiring (T2/T3/T4) live in ws-handler; they call these primitives.
 */
import type { ServerMessage } from "../types/ws-types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("orchestrator-registry");

/** An operator's reply to a strike-limit pause (3-enum; PR-4 adds a 4th path). */
export type OperatorDecision = "continue" | "escalate" | "wait";

/** A function that delivers one server message to one attached client. */
export type RunSink = (m: ServerMessage) => void;

export type RunStatus = "running" | "parked" | "terminal";

/**
 * A pause the move-loop is blocked on, awaiting either an operator decision
 * (strike-limit pause) or a reattach (auto-park). Resolving it unblocks the loop.
 * `timer` auto-resolves an operator pause after a timeout; a park pause has no
 * timer (it waits indefinitely for a reattach).
 */
export interface PendingPause {
  resolve: (decision: OperatorDecision) => void;
  timer: ReturnType<typeof setTimeout> | null;
  kind: "operator" | "park";
}

interface RunEntry {
  abort: AbortController;
  sinks: Set<RunSink>;
  pause: PendingPause | null;
  /** PR-1 D7, now cross-connection: once a pause decision is submitted, both
   *  tabs' controls lock until the loop resumes. */
  decisionLocked: boolean;
  /** Set by the watchdog when a viewerless run should park at its next checkpoint. */
  parkRequested: boolean;
  status: RunStatus;
  /** ms timestamp when `sinks` became empty; null while at least one is attached. */
  sinksEmptyAt: number | null;
  /** ms timestamp when the run reached a terminal status (for GC grace). */
  terminalAt: number | null;
}

/** Defaults (overridable per-construct for tests / config). */
export const DEFAULT_PARK_IDLE_MS = 120_000;
export const DEFAULT_TERMINAL_GRACE_MS = 30_000;

export class OrchestratorRunRegistry {
  private readonly runs = new Map<string, RunEntry>();

  // ── lifecycle ──────────────────────────────────────────────────────────
  /** Register a freshly-launched run. A LIVE-or-parked entry is preserved (the
   *  concurrency guard rejects a real double-launch). But a TERMINAL entry still
   *  in its GC grace window is replaced — otherwise a relaunch during that window
   *  would leave the new run's abort/sinks untracked (Stop/subscribe/park would
   *  operate on the dead run while the new loop ran unabortable). */
  create(investigationId: string, abort: AbortController): void {
    const existing = this.runs.get(investigationId);
    if (existing && existing.status !== "terminal") return;
    this.runs.set(investigationId, {
      abort,
      sinks: new Set(),
      pause: null,
      decisionLocked: false,
      parkRequested: false,
      status: "running",
      sinksEmptyAt: null,
      terminalAt: null,
    });
  }

  has(investigationId: string): boolean {
    return this.runs.has(investigationId);
  }

  /** True while a run is registered and not yet terminal — the "is this run
   *  live?" check used to decide reattach vs cold-replay. */
  isLive(investigationId: string): boolean {
    const e = this.runs.get(investigationId);
    return !!e && e.status !== "terminal";
  }

  status(investigationId: string): RunStatus | undefined {
    return this.runs.get(investigationId)?.status;
  }

  abortControllerFor(investigationId: string): AbortController | undefined {
    return this.runs.get(investigationId)?.abort;
  }

  /** Abort a run (operator Stop / shutdown). Also resolves any pending pause so a
   *  blocked loop unblocks and hits its abort guard. */
  abort(investigationId: string, reason?: unknown): void {
    const e = this.runs.get(investigationId);
    if (!e) return;
    this.resolvePause(investigationId, "continue");
    e.abort.abort(reason);
  }

  /** Mark a run terminal; it is swept (removed) after the grace window so a
   *  reconnecting client can still receive the terminal event live. */
  markTerminal(investigationId: string, now: number = Date.now()): void {
    const e = this.runs.get(investigationId);
    if (!e) return;
    e.status = "terminal";
    e.terminalAt = now;
    e.parkRequested = false;
    this.clearPause(investigationId);
  }

  /** Hard-remove an entry (after grace, or on teardown). */
  delete(investigationId: string): void {
    this.runs.delete(investigationId);
  }

  // ── sinks (re-targetable, multi-tab fan-out) ─────────────────────────────
  /** Attach a client's sink to a run. Clears the empty-timer (a viewer is back)
   *  and clears any pending park request — the caller resolves an active park
   *  pause separately via resolvePause. */
  attachSink(investigationId: string, sink: RunSink): void {
    const e = this.runs.get(investigationId);
    if (!e) return;
    e.sinks.add(sink);
    e.sinksEmptyAt = null;
    e.parkRequested = false;
  }

  /** Detach a sink. When the last sink leaves, stamp the time so the watchdog can
   *  park the run after PARK_IDLE_MS. The run keeps running. */
  detachSink(investigationId: string, sink: RunSink, now: number = Date.now()): void {
    const e = this.runs.get(investigationId);
    if (!e) return;
    e.sinks.delete(sink);
    if (e.sinks.size === 0) e.sinksEmptyAt = now;
  }

  sinkCount(investigationId: string): number {
    return this.runs.get(investigationId)?.sinks.size ?? 0;
  }

  /** Fan a message out to every attached sink. A sink whose send throws (a
   *  half-open socket) is dropped so it can't break the others or the run; a
   *  message with no attached sinks is simply persisted-only (handled upstream)
   *  and dropped here. */
  broadcast(investigationId: string, m: ServerMessage): void {
    const e = this.runs.get(investigationId);
    if (!e || e.sinks.size === 0) return;
    let dead: RunSink[] | null = null;
    for (const sink of e.sinks) {
      try {
        sink(m);
      } catch (err) {
        logger.warn({ err, investigationId }, "Dropping a sink that threw on send");
        (dead ??= []).push(sink);
      }
    }
    if (dead) {
      for (const s of dead) e.sinks.delete(s);
      if (e.sinks.size === 0) e.sinksEmptyAt = Date.now();
    }
  }

  // ── pause / decision-lock (cross-connection) ─────────────────────────────
  /** Set the pending pause. A fresh pause re-opens the decision lock: the new
   *  prompt is actionable again until someone submits a decision (D7). */
  setPause(investigationId: string, pause: PendingPause): void {
    const e = this.runs.get(investigationId);
    if (!e) return;
    e.pause = pause;
    e.decisionLocked = false;
  }

  hasPause(investigationId: string): boolean {
    return !!this.runs.get(investigationId)?.pause;
  }

  /** Clear a pause WITHOUT resolving it (e.g. the loop resumed on its own). Also
   *  clears its timer. */
  clearPause(investigationId: string): void {
    const e = this.runs.get(investigationId);
    if (!e || !e.pause) return;
    if (e.pause.timer) clearTimeout(e.pause.timer);
    e.pause = null;
  }

  /** Resolve a pending pause with a decision, unblocking the loop. No-op if there
   *  is no pause. Clears the timer and the pause slot. */
  resolvePause(investigationId: string, decision: OperatorDecision): void {
    const e = this.runs.get(investigationId);
    if (!e || !e.pause) return;
    const { resolve, timer } = e.pause;
    if (timer) clearTimeout(timer);
    e.pause = null;
    resolve(decision);
  }

  /** PR-1 D7 (cross-tab): try to claim the decision lock. Returns true if this
   *  caller won (lock was open), false if a decision was already submitted. */
  tryLockDecision(investigationId: string): boolean {
    const e = this.runs.get(investigationId);
    if (!e || e.decisionLocked) return false;
    e.decisionLocked = true;
    return true;
  }

  /** Release the decision lock (the loop resumed past the pause). */
  unlockDecision(investigationId: string): void {
    const e = this.runs.get(investigationId);
    if (e) e.decisionLocked = false;
  }

  // ── auto-park (T5 loop checkpoint reads/consumes this) ───────────────────
  /** Flag a run to park at its next move-loop checkpoint. */
  requestPark(investigationId: string): void {
    const e = this.runs.get(investigationId);
    if (e && e.status === "running") e.parkRequested = true;
  }

  /** Consume the park request (the loop calls this between moves). Returns true
   *  once, then clears the flag, so a single request parks exactly once. */
  consumeParkRequest(investigationId: string): boolean {
    const e = this.runs.get(investigationId);
    if (!e || !e.parkRequested) return false;
    e.parkRequested = false;
    return true;
  }

  /** Mark a run as parked (the loop entered its park pause). */
  markParked(investigationId: string): void {
    const e = this.runs.get(investigationId);
    if (e) e.status = "parked";
  }

  /** Mark a parked run running again (a reattach resolved the park pause). */
  markRunning(investigationId: string): void {
    const e = this.runs.get(investigationId);
    if (e && e.status === "parked") e.status = "running";
  }

  // ── watchdog ─────────────────────────────────────────────────────────────
  /**
   * One watchdog tick. Pure given (now, thresholds): returns the ids it acted on
   * so the caller can drive the loop (the registry can't restart a blocked loop
   * itself). Two actions:
   *  - PARK: a `running` run with no sinks for ≥ parkIdleMs → requestPark.
   *  - SWEEP: a `terminal` run past terminalGraceMs → delete.
   */
  sweep(
    now: number = Date.now(),
    parkIdleMs: number = DEFAULT_PARK_IDLE_MS,
    terminalGraceMs: number = DEFAULT_TERMINAL_GRACE_MS,
  ): { parked: string[]; swept: string[] } {
    const parked: string[] = [];
    const swept: string[] = [];
    for (const [id, e] of this.runs) {
      if (
        e.status === "running" &&
        !e.parkRequested &&
        e.sinks.size === 0 &&
        e.sinksEmptyAt !== null &&
        now - e.sinksEmptyAt >= parkIdleMs
      ) {
        e.parkRequested = true;
        parked.push(id);
      } else if (e.status === "terminal" && e.terminalAt !== null && now - e.terminalAt >= terminalGraceMs) {
        this.runs.delete(id);
        swept.push(id);
      }
    }
    return { parked, swept };
  }

  /** Live run count (diagnostics / health). */
  size(): number {
    return this.runs.size;
  }
}

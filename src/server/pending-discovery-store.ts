import type BetterSqlite3 from "better-sqlite3";
import { ulid, monotonicFactory } from "ulid";
import type { ServiceConfig, ProbeMetricRule } from "../config/schema.js";

// Run ids must be strictly monotonically increasing so that
// `getPreviousSuccessfulRunId(stackId, currentRunId)` is correct even when
// two ticks land in the same millisecond. The basic `ulid()` factory uses
// fresh randomness each call — within one ms the lex order is undefined.
const monotonicUlid = monotonicFactory();

export type ChangeKind = "addition" | "removal";

export interface PendingRow {
  id: string;
  stackId: string;
  serviceName: string;
  changeKind: ChangeKind;
  payload: string | null;
  globalsSnapshot: string | null;
  registryVersionAtQualification: string | null;
  firstSeenAt: string;
  lastSeenRunId: string;
  seenCount: number;
  qualifiedAt: string | null;
  notifiedAt: string | null;
  viewedAt: string | null;
}

export interface DismissedRow {
  id: string;
  stackId: string;
  serviceName: string;
  changeKind: ChangeKind;
  dismissedAt: string;
}

interface RawPendingRow {
  id: string;
  stack_id: string;
  service_name: string;
  change_kind: ChangeKind;
  payload: string | null;
  globals_snapshot: string | null;
  registry_version_at_qualification: string | null;
  first_seen_at: string;
  last_seen_run_id: string;
  seen_count: number;
  qualified_at: string | null;
  notified_at: string | null;
  viewed_at: string | null;
}

export interface RunRow {
  id: string;
  stackId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failed" | "skipped";
  serviceCount: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  error: string | null;
}

interface RawRunRow {
  id: string;
  stack_id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "failed" | "skipped";
  service_count: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  error: string | null;
}

function toRunRow(r: RawRunRow): RunRow {
  return {
    id: r.id, stackId: r.stack_id, startedAt: r.started_at, finishedAt: r.finished_at,
    status: r.status, serviceCount: r.service_count,
    tokensInput: r.tokens_input, tokensOutput: r.tokens_output, error: r.error,
  };
}

function toPendingRow(r: RawPendingRow): PendingRow {
  return {
    id: r.id,
    stackId: r.stack_id,
    serviceName: r.service_name,
    changeKind: r.change_kind,
    payload: r.payload,
    globalsSnapshot: r.globals_snapshot,
    registryVersionAtQualification: r.registry_version_at_qualification,
    firstSeenAt: r.first_seen_at,
    lastSeenRunId: r.last_seen_run_id,
    seenCount: r.seen_count,
    qualifiedAt: r.qualified_at,
    notifiedAt: r.notified_at,
    viewedAt: r.viewed_at,
  };
}

export class PendingDiscoveryStore {
  constructor(private db: BetterSqlite3.Database) {}

  upsertAddition(args: {
    stackId: string;
    serviceName: string;
    payload: ServiceConfig;
    globalsSnapshot: ProbeMetricRule[];
    runId: string;
  }): string {
    const now = new Date().toISOString();
    const payloadJson = JSON.stringify(args.payload);
    const globalsJson = JSON.stringify(args.globalsSnapshot);
    const existing = this.db.prepare(
      "SELECT id FROM pending_discoveries WHERE stack_id = ? AND service_name = ? AND change_kind = 'addition'",
    ).get(args.stackId, args.serviceName) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(
        "UPDATE pending_discoveries SET seen_count = seen_count + 1, last_seen_run_id = ?, payload = ?, globals_snapshot = ? WHERE id = ?",
      ).run(args.runId, payloadJson, globalsJson, existing.id);
      return existing.id;
    }
    const id = ulid();
    this.db.prepare(
      "INSERT INTO pending_discoveries (id, stack_id, service_name, change_kind, payload, globals_snapshot, first_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, ?, 'addition', ?, ?, ?, ?, 1)",
    ).run(id, args.stackId, args.serviceName, payloadJson, globalsJson, now, args.runId);
    return id;
  }

  upsertRemoval(args: { stackId: string; serviceName: string; runId: string }): string {
    const now = new Date().toISOString();
    const existing = this.db.prepare(
      "SELECT id FROM pending_discoveries WHERE stack_id = ? AND service_name = ? AND change_kind = 'removal'",
    ).get(args.stackId, args.serviceName) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(
        "UPDATE pending_discoveries SET seen_count = seen_count + 1, last_seen_run_id = ? WHERE id = ?",
      ).run(args.runId, existing.id);
      return existing.id;
    }
    const id = ulid();
    this.db.prepare(
      "INSERT INTO pending_discoveries (id, stack_id, service_name, change_kind, first_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, ?, 'removal', ?, ?, 1)",
    ).run(id, args.stackId, args.serviceName, now, args.runId);
    return id;
  }

  resetSeenCount(id: string, runId: string): void {
    this.db.prepare(
      "UPDATE pending_discoveries SET seen_count = 1, last_seen_run_id = ?, qualified_at = NULL, registry_version_at_qualification = NULL, notified_at = NULL, viewed_at = NULL WHERE id = ?",
    ).run(runId, id);
  }

  markQualified(id: string, registryVersion: string): void {
    this.db.prepare(
      "UPDATE pending_discoveries SET qualified_at = COALESCE(qualified_at, ?), registry_version_at_qualification = COALESCE(registry_version_at_qualification, ?) WHERE id = ?",
    ).run(new Date().toISOString(), registryVersion, id);
  }

  findById(id: string): PendingRow | null {
    const row = this.db.prepare("SELECT * FROM pending_discoveries WHERE id = ?").get(id) as RawPendingRow | undefined;
    return row ? toPendingRow(row) : null;
  }

  findByStackKindName(stackId: string, kind: ChangeKind, serviceName: string): PendingRow | null {
    const row = this.db.prepare(
      "SELECT * FROM pending_discoveries WHERE stack_id = ? AND change_kind = ? AND service_name = ?",
    ).get(stackId, kind, serviceName) as RawPendingRow | undefined;
    return row ? toPendingRow(row) : null;
  }

  listPending(stackId: string, kind: ChangeKind): PendingRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM pending_discoveries WHERE stack_id = ? AND change_kind = ?",
    ).all(stackId, kind) as RawPendingRow[];
    return rows.map(toPendingRow);
  }

  listQualified(stackId: string, kind: ChangeKind): PendingRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM pending_discoveries WHERE stack_id = ? AND change_kind = ? AND qualified_at IS NOT NULL ORDER BY qualified_at DESC",
    ).all(stackId, kind) as RawPendingRow[];
    return rows.map(toPendingRow);
  }

  /**
   * Delete a pending row AND its discovery_notifications children.
   * Foreign keys are OFF project-wide so the ON DELETE CASCADE is declarative
   * only; we sweep the child rows explicitly inside a transaction.
   */
  deleteById(id: string): void {
    const tx = this.db.transaction((rowId: string) => {
      this.db.prepare("DELETE FROM discovery_notifications WHERE pending_id = ?").run(rowId);
      this.db.prepare("DELETE FROM pending_discoveries WHERE id = ?").run(rowId);
    });
    tx(id);
  }

  deleteByStackKindName(stackId: string, kind: ChangeKind, serviceName: string): void {
    const row = this.findByStackKindName(stackId, kind, serviceName);
    if (!row) return;
    this.deleteById(row.id);
  }

  // ── Dismissed ────────────────────────────────────────────────────────────

  dismiss(pendingId: string): void {
    const tx = this.db.transaction((id: string) => {
      const row = this.db.prepare("SELECT * FROM pending_discoveries WHERE id = ?").get(id) as RawPendingRow | undefined;
      if (!row) return;
      this.db.prepare(
        "INSERT INTO dismissed_discoveries (id, stack_id, service_name, change_kind, dismissed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(stack_id, service_name, change_kind) DO UPDATE SET dismissed_at = excluded.dismissed_at",
      ).run(ulid(), row.stack_id, row.service_name, row.change_kind, new Date().toISOString());
      this.db.prepare("DELETE FROM discovery_notifications WHERE pending_id = ?").run(id);
      this.db.prepare("DELETE FROM pending_discoveries WHERE id = ?").run(id);
    });
    tx(pendingId);
  }

  isDismissed(stackId: string, serviceName: string, kind: ChangeKind): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM dismissed_discoveries WHERE stack_id = ? AND service_name = ? AND change_kind = ?",
    ).get(stackId, serviceName, kind);
    return row !== undefined;
  }

  listDismissed(stackId: string): DismissedRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM dismissed_discoveries WHERE stack_id = ? ORDER BY dismissed_at DESC",
    ).all(stackId) as Array<{
      id: string; stack_id: string; service_name: string; change_kind: ChangeKind; dismissed_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id, stackId: r.stack_id, serviceName: r.service_name,
      changeKind: r.change_kind, dismissedAt: r.dismissed_at,
    }));
  }

  restoreDismissed(dismissedId: string): void {
    this.db.prepare("DELETE FROM dismissed_discoveries WHERE id = ?").run(dismissedId);
  }

  // ── Notifications ────────────────────────────────────────────────────────

  recordNotificationAttempt(
    pendingId: string,
    channel: "slack" | "email" | "badge",
    status: "success" | "failed",
    error: string | null = null,
  ): void {
    this.db.prepare(
      "INSERT INTO discovery_notifications (id, pending_id, channel, attempted_at, status, error) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(pending_id, channel) DO UPDATE SET attempted_at = excluded.attempted_at, status = excluded.status, error = excluded.error",
    ).run(ulid(), pendingId, channel, new Date().toISOString(), status, error);
  }

  hasSuccessfulNotification(pendingId: string, channel: "slack" | "email" | "badge"): boolean {
    const r = this.db.prepare(
      "SELECT 1 FROM discovery_notifications WHERE pending_id = ? AND channel = ? AND status = 'success'",
    ).get(pendingId, channel);
    return r !== undefined;
  }

  markNotifiedNow(pendingId: string): void {
    this.db.prepare(
      "UPDATE pending_discoveries SET notified_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), pendingId);
  }

  markViewed(pendingIds: string[]): void {
    if (pendingIds.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare("UPDATE pending_discoveries SET viewed_at = ? WHERE id = ?");
    const tx = this.db.transaction((ids: string[]) => { for (const id of ids) stmt.run(now, id); });
    tx(pendingIds);
  }

  countUnviewed(stackId: string): number {
    const r = this.db.prepare(
      "SELECT COUNT(*) AS n FROM pending_discoveries WHERE stack_id = ? AND qualified_at IS NOT NULL AND viewed_at IS NULL",
    ).get(stackId) as { n: number };
    return r.n;
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  startRun(stackId: string): string {
    const id = monotonicUlid();
    this.db.prepare(
      "INSERT INTO periodic_discovery_runs (id, stack_id, started_at, status) VALUES (?, ?, ?, 'running')",
    ).run(id, stackId, new Date().toISOString());
    return id;
  }

  finishRun(runId: string, args: {
    status: "success" | "failed" | "skipped";
    serviceCount?: number | null;
    tokensInput?: number | null;
    tokensOutput?: number | null;
    error?: string | null;
  }): void {
    this.db.prepare(
      "UPDATE periodic_discovery_runs SET finished_at = ?, status = ?, service_count = ?, tokens_input = ?, tokens_output = ?, error = ? WHERE id = ?",
    ).run(
      new Date().toISOString(),
      args.status,
      args.serviceCount ?? null,
      args.tokensInput ?? null,
      args.tokensOutput ?? null,
      args.error ?? null,
      runId,
    );
  }

  getRun(runId: string): RunRow | null {
    const row = this.db.prepare("SELECT * FROM periodic_discovery_runs WHERE id = ?").get(runId) as RawRunRow | undefined;
    return row ? toRunRow(row) : null;
  }

  listRuns(stackId: string, limit = 10): RunRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM periodic_discovery_runs WHERE stack_id = ? ORDER BY started_at DESC LIMIT ?",
    ).all(stackId, limit) as RawRunRow[];
    return rows.map(toRunRow);
  }

  getPreviousSuccessfulRunId(stackId: string, beforeRunId: string): string | null {
    // ULIDs are lexicographically time-sortable AND collision-free, so we can
    // order by id directly. Avoids timestamp-tie issues when two runs land in
    // the same millisecond (common in fast tests + back-to-back cron ticks).
    const r = this.db.prepare(
      "SELECT id FROM periodic_discovery_runs WHERE stack_id = ? AND status = 'success' AND id < ? ORDER BY id DESC LIMIT 1",
    ).get(stackId, beforeRunId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  resetOrphanedRunningRuns(): void {
    this.db.prepare(
      "UPDATE periodic_discovery_runs SET status = 'failed', error = 'interrupted', finished_at = ? WHERE status = 'running'",
    ).run(new Date().toISOString());
  }
}

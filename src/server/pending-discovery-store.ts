import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { ServiceConfig, ProbeMetricRule } from "../config/schema.js";

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
}

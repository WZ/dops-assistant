import BetterSqlite3 from "better-sqlite3";
import type { StackRow } from "../types/stack-types.js";

/**
 * Converts a SQLite datetime string (YYYY-MM-DD HH:MM:SS, UTC) to ISO 8601.
 * SQLite datetime('now') produces no T separator and no Z suffix; Safari
 * cannot reliably parse that format.  We append 'Z' to tell Date() it's UTC,
 * then call toISOString() to get a canonical representation.
 */
export function normalizeTimestamp(sqliteStr: string): string {
  try {
    return new Date(sqliteStr + "Z").toISOString();
  } catch {
    return sqliteStr;
  }
}

/**
 * Recursively walks an object (or array) and converts every string property
 * whose key ends with `_at` from SQLite format to ISO 8601.  Non-`_at`
 * strings and all other value types are left untouched.
 */
export function normalizeRow<T>(row: T): T {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) {
    return row.map(normalizeRow) as unknown as T;
  }
  if (typeof row === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (k.endsWith("_at") && typeof v === "string" && v.length > 0) {
        // Only convert if it looks like a SQLite datetime (no T separator)
        out[k] = v.includes("T") ? v : normalizeTimestamp(v);
      } else {
        out[k] = v;
      }
    }
    return out as T;
  }
  return row;
}

export interface InvestigationRow {
  id: string;
  service: string;
  query: string;
  status: string;
  report: string | null;
  created_at: string;
  completed_at: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_duration_ms: number;
  confidence_score: number | null;
}

export interface KpiStats {
  investigations: { total: number; active: number; complete: number; failed: number };
  successRate: number | null;
  confidence: { avg: number | null; scored: number; lowConfidence: number };
  mttr: { avg7d: number; completed7d: number; trend?: { direction: "up" | "down"; value: string; positive: boolean } };
}

export interface PhaseRow {
  id: string;
  investigation_id: string;
  phase: string;
  status: string;
  findings: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface ServiceMetadataRow {
  service: string;
  alias: string | null;
  tags: string[];
  updated_at: string;
}

export interface EventRow {
  id: string;
  investigation_id: string;
  event_type: string;
  payload: string;
  created_at: string;
}

export interface MessageRow {
  id: string;
  investigation_id: string | null;
  role: string;
  content: string;
  chart_data: string | null;
  created_at: string;
}

export class Database {
  private db: BetterSqlite3.Database;

  constructor(path: string) {
    this.db = new BetterSqlite3(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.migrateServiceMetadata();
    this.migrateStacks();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS investigations (
        id            TEXT PRIMARY KEY,
        service       TEXT NOT NULL,
        query         TEXT NOT NULL,
        status        TEXT NOT NULL,
        report        TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT
      );
      CREATE TABLE IF NOT EXISTS investigation_phases (
        id                TEXT PRIMARY KEY,
        investigation_id  TEXT NOT NULL REFERENCES investigations(id),
        phase             TEXT NOT NULL,
        status            TEXT NOT NULL,
        findings          TEXT,
        started_at        TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at      TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id                TEXT PRIMARY KEY,
        investigation_id  TEXT,
        role              TEXT NOT NULL,
        content           TEXT NOT NULL,
        chart_data        TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Migration: add chart_data to messages if missing
    `);
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN chart_data TEXT`);
    } catch { /* column already exists */ }
    try { this.db.exec("ALTER TABLE investigations ADD COLUMN total_input_tokens INTEGER DEFAULT 0"); } catch {}
    try { this.db.exec("ALTER TABLE investigations ADD COLUMN total_output_tokens INTEGER DEFAULT 0"); } catch {}
    try { this.db.exec("ALTER TABLE investigations ADD COLUMN total_duration_ms INTEGER DEFAULT 0"); } catch {}
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS investigation_events (
        id                TEXT PRIMARY KEY,
        investigation_id  TEXT NOT NULL REFERENCES investigations(id),
        event_type        TEXT NOT NULL,
        payload           TEXT NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS investigation_feedback (
        id                TEXT PRIMARY KEY,
        investigation_id  TEXT NOT NULL REFERENCES investigations(id),
        rating            TEXT NOT NULL CHECK(rating IN ('useful', 'not_useful')),
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS incident_patterns (
        id                TEXT PRIMARY KEY,
        service           TEXT NOT NULL,
        symptom           TEXT NOT NULL,
        root_cause        TEXT NOT NULL,
        severity          TEXT NOT NULL,
        recommended_actions TEXT,
        source_investigation_id TEXT REFERENCES investigations(id),
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.migrateServiceHealthChecks();
    this.migrateHiddenServices();
    this.migrateSettings();
  }

  // ── Settings migration ─────────────────────────────────────────────────

  private migrateSettings(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  // ── Stack migration ──────────────────────────────────────────────────────

  private migrateStacks(): void {
    // Create stacks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stacks (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        slug       TEXT NOT NULL UNIQUE,
        config     TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Add stack_id column to tables that need it
    try { this.db.exec("ALTER TABLE investigations ADD COLUMN stack_id TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE messages ADD COLUMN stack_id TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE service_health_checks ADD COLUMN stack_id TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE investigation_feedback ADD COLUMN stack_id TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE incident_patterns ADD COLUMN stack_id TEXT"); } catch {}

    // Migrate hidden_services to composite PK (stack_id, service)
    // Check if migration is needed by looking for the stack_id column
    const hiddenInfo = this.db.prepare("PRAGMA table_info(hidden_services)").all() as Array<{ name: string }>;
    const hiddenHasStackId = hiddenInfo.some(col => col.name === "stack_id");
    if (!hiddenHasStackId) {
      this.db.exec(`
        DROP TABLE IF EXISTS hidden_services_new;
        CREATE TABLE IF NOT EXISTS hidden_services_new (
          stack_id  TEXT NOT NULL,
          service   TEXT NOT NULL,
          reason    TEXT,
          hidden_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (stack_id, service)
        );
        INSERT OR IGNORE INTO hidden_services_new (stack_id, service, reason, hidden_at)
          SELECT '' as stack_id, service, reason, hidden_at FROM hidden_services;
        DROP TABLE IF EXISTS hidden_services;
        ALTER TABLE hidden_services_new RENAME TO hidden_services;
      `);
    }

    // Migrate service_metadata to composite PK (stack_id, service)
    const metaInfo = this.db.prepare("PRAGMA table_info(service_metadata)").all() as Array<{ name: string }>;
    const metaHasStackId = metaInfo.some(col => col.name === "stack_id");
    if (!metaHasStackId) {
      this.db.exec(`
        DROP TABLE IF EXISTS service_metadata_new;
        CREATE TABLE IF NOT EXISTS service_metadata_new (
          stack_id   TEXT NOT NULL,
          service    TEXT NOT NULL,
          alias      TEXT,
          tags       TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (stack_id, service)
        );
        INSERT OR IGNORE INTO service_metadata_new (stack_id, service, alias, tags, updated_at)
          SELECT '' as stack_id, service, alias, tags, updated_at FROM service_metadata;
        DROP TABLE IF EXISTS service_metadata;
        ALTER TABLE service_metadata_new RENAME TO service_metadata;
      `);
    }

    // Indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inv_stack ON investigations (stack_id);
      CREATE INDEX IF NOT EXISTS idx_msg_stack ON messages (stack_id);
      CREATE INDEX IF NOT EXISTS idx_shc_stack ON service_health_checks (stack_id, service, checked_at);
    `);
  }

  // ── Backfill default stack ───────────────────────────────────────────────

  backfillDefaultStack(defaultStackId: string): void {
    this.db.prepare(`UPDATE investigations SET stack_id = ? WHERE stack_id IS NULL OR stack_id = ''`).run(defaultStackId);
    this.db.prepare(`UPDATE messages SET stack_id = ? WHERE stack_id IS NULL OR stack_id = ''`).run(defaultStackId);
    this.db.prepare(`UPDATE service_health_checks SET stack_id = ? WHERE stack_id IS NULL OR stack_id = ''`).run(defaultStackId);
    this.db.prepare(`UPDATE investigation_feedback SET stack_id = ? WHERE stack_id IS NULL OR stack_id = ''`).run(defaultStackId);
    this.db.prepare(`UPDATE incident_patterns SET stack_id = ? WHERE stack_id IS NULL OR stack_id = ''`).run(defaultStackId);
    this.db.prepare(`UPDATE hidden_services SET stack_id = ? WHERE stack_id = ''`).run(defaultStackId);
    this.db.prepare(`UPDATE service_metadata SET stack_id = ? WHERE stack_id = ''`).run(defaultStackId);
  }

  // ── Stack CRUD ───────────────────────────────────────────────────────────

  createStack(stack: { id: string; name: string; slug: string; config: string }): void {
    this.db.prepare(
      "INSERT INTO stacks (id, name, slug, config) VALUES (?, ?, ?, ?)"
    ).run(stack.id, stack.name, stack.slug, stack.config);
  }

  getStack(id: string): StackRow | undefined {
    return this.db.prepare(
      "SELECT * FROM stacks WHERE id = ?"
    ).get(id) as StackRow | undefined;
  }

  getStackBySlug(slug: string): StackRow | undefined {
    return this.db.prepare(
      "SELECT * FROM stacks WHERE slug = ?"
    ).get(slug) as StackRow | undefined;
  }

  listStacks(): StackRow[] {
    return this.db.prepare(
      "SELECT * FROM stacks ORDER BY created_at ASC"
    ).all() as StackRow[];
  }

  updateStack(id: string, updates: { name?: string; slug?: string; config?: string }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (updates.name !== undefined) { sets.push("name = ?"); vals.push(updates.name); }
    if (updates.slug !== undefined) { sets.push("slug = ?"); vals.push(updates.slug); }
    if (updates.config !== undefined) { sets.push("config = ?"); vals.push(updates.config); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE stacks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  deleteStack(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM service_metadata WHERE stack_id = ?").run(id);
      this.db.prepare("DELETE FROM hidden_services WHERE stack_id = ?").run(id);
      this.db.prepare("DELETE FROM incident_patterns WHERE stack_id = ?").run(id);
      this.db.prepare("DELETE FROM investigation_feedback WHERE stack_id = ?").run(id);
      this.db.prepare("DELETE FROM service_health_checks WHERE stack_id = ?").run(id);
      this.db.prepare("DELETE FROM messages WHERE stack_id = ?").run(id);
      // Delete child tables of investigations before investigations (FK enforcement is OFF)
      this.db.prepare("DELETE FROM investigation_events WHERE investigation_id IN (SELECT id FROM investigations WHERE stack_id = ?)").run(id);
      this.db.prepare("DELETE FROM investigation_phases WHERE investigation_id IN (SELECT id FROM investigations WHERE stack_id = ?)").run(id);
      this.db.prepare("DELETE FROM investigations WHERE stack_id = ?").run(id);
      this.db.prepare("DELETE FROM stacks WHERE id = ?").run(id);
    });
    tx();
  }

  // ── Investigation CRUD ────────────────────────────────────────────────────

  createInvestigation(stackId: string, inv: { id: string; service: string; query: string; status: string }): void {
    this.db.prepare("INSERT INTO investigations (id, service, query, status, stack_id) VALUES (?, ?, ?, ?, ?)").run(inv.id, inv.service, inv.query, inv.status, stackId);
  }

  updateInvestigation(id: string, updates: { status?: string; report?: string; completed_at?: string; total_input_tokens?: number; total_output_tokens?: number; total_duration_ms?: number }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (updates.status !== undefined) { sets.push("status = ?"); vals.push(updates.status); }
    if (updates.report !== undefined) { sets.push("report = ?"); vals.push(updates.report); }
    if (updates.completed_at !== undefined) { sets.push("completed_at = ?"); vals.push(updates.completed_at); }
    else if (updates.status === "complete" || updates.status === "failed") { sets.push("completed_at = datetime('now')"); }
    if (updates.total_input_tokens !== undefined) { sets.push("total_input_tokens = ?"); vals.push(updates.total_input_tokens); }
    if (updates.total_output_tokens !== undefined) { sets.push("total_output_tokens = ?"); vals.push(updates.total_output_tokens); }
    if (updates.total_duration_ms !== undefined) { sets.push("total_duration_ms = ?"); vals.push(updates.total_duration_ms); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE investigations SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  getInvestigation(stackId: string, id: string): InvestigationRow | undefined {
    const row = this.db.prepare(
      "SELECT *, CASE WHEN json_valid(report) THEN json_extract(report, '$.confidenceScore') ELSE NULL END as confidence_score FROM investigations WHERE id = ? AND stack_id = ?"
    ).get(id, stackId) as InvestigationRow | undefined;
    return row ? normalizeRow(row) : undefined;
  }

  listInvestigations(stackId: string, limit: number, offset: number, service?: string): InvestigationRow[] {
    if (service) {
      return (this.db.prepare(
        "SELECT *, CASE WHEN json_valid(report) THEN json_extract(report, '$.confidenceScore') ELSE NULL END as confidence_score FROM investigations WHERE stack_id = ? AND service = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?"
      ).all(stackId, service, limit, offset) as InvestigationRow[]).map(normalizeRow);
    }
    return (this.db.prepare(
      "SELECT *, CASE WHEN json_valid(report) THEN json_extract(report, '$.confidenceScore') ELSE NULL END as confidence_score FROM investigations WHERE stack_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?"
    ).all(stackId, limit, offset) as InvestigationRow[]).map(normalizeRow);
  }

  createPhase(phase: { id: string; investigationId: string; phase: string; status: string }): void {
    this.db.prepare("INSERT INTO investigation_phases (id, investigation_id, phase, status) VALUES (?, ?, ?, ?)").run(phase.id, phase.investigationId, phase.phase, phase.status);
  }

  updatePhase(id: string, updates: { status?: string; findings?: string; completed_at?: string }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (updates.status !== undefined) { sets.push("status = ?"); vals.push(updates.status); }
    if (updates.findings !== undefined) { sets.push("findings = ?"); vals.push(updates.findings); }
    if (updates.completed_at !== undefined) { sets.push("completed_at = ?"); vals.push(updates.completed_at); }
    else if (updates.status === "complete" || updates.status === "failed") { sets.push("completed_at = datetime('now')"); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE investigation_phases SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  getPhases(investigationId: string): PhaseRow[] {
    return (this.db.prepare("SELECT * FROM investigation_phases WHERE investigation_id = ? ORDER BY started_at ASC").all(investigationId) as PhaseRow[]).map(normalizeRow);
  }

  createEvent(event: { id: string; investigationId: string; eventType: string; payload: string }): void {
    this.db.prepare("INSERT INTO investigation_events (id, investigation_id, event_type, payload) VALUES (?, ?, ?, ?)").run(event.id, event.investigationId, event.eventType, event.payload);
  }

  getEvents(investigationId: string): EventRow[] {
    return (this.db.prepare("SELECT * FROM investigation_events WHERE investigation_id = ? ORDER BY created_at ASC, rowid ASC").all(investigationId) as EventRow[]).map(normalizeRow);
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  createMessage(stackId: string, msg: { id: string; role: string; content: string; investigationId?: string; chartData?: string }): void {
    this.db.prepare("INSERT INTO messages (id, investigation_id, role, content, chart_data, stack_id) VALUES (?, ?, ?, ?, ?, ?)").run(msg.id, msg.investigationId ?? null, msg.role, msg.content, msg.chartData ?? null, stackId);
  }

  listRecentMessages(stackId: string, limit: number): MessageRow[] {
    return (this.db.prepare(
      "SELECT * FROM (SELECT *, rowid AS _rid FROM messages WHERE stack_id = ? AND investigation_id IS NULL ORDER BY created_at DESC, _rid DESC LIMIT ?) ORDER BY created_at ASC, _rid ASC"
    ).all(stackId, limit) as MessageRow[]).map(normalizeRow);
  }

  listMessages(stackId: string, limit: number, investigationId?: string): MessageRow[] {
    if (investigationId) {
      return (this.db.prepare("SELECT * FROM messages WHERE investigation_id = ? AND stack_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?").all(investigationId, stackId, limit) as MessageRow[]).map(normalizeRow);
    }
    // Include console messages (no investigation_id) AND investigation completion summaries
    // (content starts with "**Root Cause:**") which render as RCA cards in the console.
    // Deep Investigation follow-up Q&A is excluded.
    return (this.db.prepare(
      "SELECT * FROM (SELECT *, rowid AS _rid FROM messages WHERE stack_id = ? AND (investigation_id IS NULL OR content LIKE '**Root Cause:**%') ORDER BY created_at DESC, _rid DESC LIMIT ?) ORDER BY created_at ASC, _rid ASC"
    ).all(stackId, limit) as MessageRow[]).map(normalizeRow);
  }

  deleteMessage(stackId: string, id: string): boolean {
    const result = this.db.prepare("DELETE FROM messages WHERE id = ? AND stack_id = ? AND investigation_id IS NULL").run(id, stackId);
    return result.changes > 0;
  }

  clearConsoleMessages(stackId: string): number {
    const result = this.db.prepare("DELETE FROM messages WHERE stack_id = ? AND investigation_id IS NULL").run(stackId);
    return result.changes;
  }

  /**
   * Mark investigations stuck in 'running' status as 'failed'.
   * Called on server startup to clean up after crashes.
   * Only marks investigations older than staleMinutes as stale.
   */
  markStaleInvestigations(staleMinutes = 10): number {
    const result = this.db.prepare(
      `UPDATE investigations SET status = 'failed', completed_at = datetime('now')
       WHERE status = 'running' AND created_at < datetime('now', '-' || ? || ' minutes')`
    ).run(Math.floor(staleMinutes));
    return result.changes;
  }

  // ── KPI Stats ──────────────────────────────────────────────────────────

  getKpiStats(stackId: string): KpiStats {
    // Investigation counts
    const counts = this.db.prepare(
      `SELECT COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) as active,
        COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) as complete,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
       FROM investigations WHERE stack_id = ?`
    ).get(stackId) as { total: number; active: number; complete: number; failed: number };

    // Success rate (exclude stale-cleanup: failed with no report)
    const completedCount = counts.complete;
    const realFailedCount = (this.db.prepare(
      `SELECT COUNT(*) as c FROM investigations WHERE stack_id = ? AND status = 'failed' AND report IS NOT NULL`
    ).get(stackId) as { c: number }).c;
    const successDenom = completedCount + realFailedCount;
    const successRate = successDenom > 0 ? (completedCount / successDenom) * 100 : null;

    // Confidence (from completed investigations, json_valid guard)
    const conf = this.db.prepare(
      `SELECT
        AVG(CASE WHEN json_valid(report) THEN json_extract(report, '$.confidenceScore') ELSE NULL END) as avg,
        COUNT(CASE WHEN json_valid(report) AND json_extract(report, '$.confidenceScore') IS NOT NULL THEN 1 END) as scored,
        COUNT(CASE WHEN json_valid(report) AND json_extract(report, '$.confidenceScore') IS NOT NULL
          AND json_extract(report, '$.confidenceScore') < 0.5 THEN 1 END) as low
       FROM investigations WHERE stack_id = ? AND status = 'complete'`
    ).get(stackId) as { avg: number | null; scored: number; low: number };

    // MTTR (7d window + prior 7d for trend)
    const mttr7d = this.db.prepare(
      `SELECT AVG(total_duration_ms) as avg, COUNT(*) as count
       FROM investigations
       WHERE stack_id = ? AND status = 'complete' AND completed_at >= datetime('now', '-7 days')`
    ).get(stackId) as { avg: number | null; count: number };

    const mttrPrior = this.db.prepare(
      `SELECT AVG(total_duration_ms) as avg
       FROM investigations
       WHERE stack_id = ? AND status = 'complete'
         AND completed_at >= datetime('now', '-14 days')
         AND completed_at < datetime('now', '-7 days')`
    ).get(stackId) as { avg: number | null };

    let trend: KpiStats["mttr"]["trend"];
    if (mttr7d.avg && mttrPrior.avg) {
      const pctChange = ((mttr7d.avg - mttrPrior.avg) / mttrPrior.avg) * 100;
      if (pctChange < 0) {
        trend = { direction: "down", value: `${Math.abs(Math.round(pctChange))}%`, positive: true };
      } else if (pctChange > 0) {
        trend = { direction: "up", value: `${Math.round(pctChange)}%`, positive: false };
      }
    }

    return {
      investigations: counts,
      successRate,
      confidence: { avg: conf.avg, scored: conf.scored, lowConfidence: conf.low },
      mttr: { avg7d: mttr7d.avg ?? 0, completed7d: mttr7d.count, trend },
    };
  }

  // ── Feedback ─────────────────────────────────────────────────────────────

  createFeedback(stackId: string, fb: { id: string; investigationId: string; rating: "useful" | "not_useful" }): void {
    this.db.prepare("INSERT INTO investigation_feedback (id, investigation_id, rating, stack_id) VALUES (?, ?, ?, ?)").run(fb.id, fb.investigationId, fb.rating, stackId);
  }

  getFeedback(investigationId: string): { rating: string; created_at: string } | undefined {
    const row = this.db.prepare("SELECT rating, created_at FROM investigation_feedback WHERE investigation_id = ? ORDER BY created_at DESC LIMIT 1").get(investigationId) as { rating: string; created_at: string } | undefined;
    return row ? normalizeRow(row) : undefined;
  }

  // ── Incident patterns ───────────────────────────────────────────────────

  createPattern(stackId: string, p: { id: string; service: string; symptom: string; rootCause: string; severity: string; recommendedActions?: string; sourceInvestigationId?: string }): void {
    this.db.prepare(
      "INSERT INTO incident_patterns (id, service, symptom, root_cause, severity, recommended_actions, source_investigation_id, stack_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(p.id, p.service, p.symptom, p.rootCause, p.severity, p.recommendedActions ?? null, p.sourceInvestigationId ?? null, stackId);
  }

  findSimilarPatterns(stackId: string, service: string, limit = 5): Array<{ id: string; service: string; symptom: string; root_cause: string; severity: string; recommended_actions: string | null; created_at: string }> {
    return (this.db.prepare(
      "SELECT id, service, symptom, root_cause, severity, recommended_actions, created_at FROM incident_patterns WHERE stack_id = ? AND service = ? ORDER BY created_at DESC LIMIT ?"
    ).all(stackId, service, limit) as any[]).map(normalizeRow);
  }

  // ── Service health checks ────────────────────────────────────────────────

  /**
   * Migrate service_health_checks table if it doesn't exist.
   * Safe to call multiple times — uses CREATE TABLE IF NOT EXISTS.
   */
  migrateServiceHealthChecks(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_health_checks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        service    TEXT NOT NULL,
        status     TEXT NOT NULL,
        checked_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_shc_service_checked ON service_health_checks (service, checked_at);
    `);
  }

  insertServiceHealthCheck(stackId: string, service: string, status: string, checkedAt: string): void {
    this.db.prepare(
      "INSERT INTO service_health_checks (service, status, checked_at, stack_id) VALUES (?, ?, ?, ?)"
    ).run(service, status, checkedAt, stackId);
  }

  getServiceHealthHistory(stackId: string, service: string, hours: number): Array<{ status: string; checked_at: string }> {
    // Compute the cutoff timestamp in JS to avoid SQL string concatenation
    const cutoff = new Date(Date.now() - Math.ceil(hours) * 3600 * 1000).toISOString();
    return this.db.prepare(
      `SELECT status, checked_at FROM service_health_checks
       WHERE stack_id = ? AND service = ? AND checked_at >= ?
       ORDER BY checked_at ASC`
    ).all(stackId, service, cutoff) as Array<{ status: string; checked_at: string }>;
  }

  // ── Hidden services ──────────────────────────────────────────────────────

  migrateHiddenServices(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hidden_services (
        service   TEXT PRIMARY KEY,
        reason    TEXT,
        hidden_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  hideService(stackId: string, service: string, reason?: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO hidden_services (stack_id, service, reason) VALUES (?, ?, ?)"
    ).run(stackId, service, reason ?? null);
  }

  unhideService(stackId: string, service: string): void {
    this.db.prepare("DELETE FROM hidden_services WHERE stack_id = ? AND service = ?").run(stackId, service);
  }

  getHiddenServices(stackId: string): Set<string> {
    const rows = this.db.prepare("SELECT service FROM hidden_services WHERE stack_id = ?").all(stackId) as Array<{ service: string }>;
    return new Set(rows.map(r => r.service));
  }

  getHiddenServiceDetails(stackId: string): Array<{ service: string; reason: string | null; hidden_at: string }> {
    return (this.db.prepare(
      "SELECT service, reason, hidden_at FROM hidden_services WHERE stack_id = ? ORDER BY hidden_at DESC"
    ).all(stackId) as Array<{ service: string; reason: string | null; hidden_at: string }>).map(normalizeRow);
  }

  hideServices(stackId: string, services: string[], reason?: string): void {
    if (services.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO hidden_services (stack_id, service, reason) VALUES (?, ?, ?)"
    );
    const tx = this.db.transaction((svcs: string[]) => {
      for (const svc of svcs) stmt.run(stackId, svc, reason ?? null);
    });
    tx(services);
  }

  isServiceHidden(stackId: string, service: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM hidden_services WHERE stack_id = ? AND service = ?").get(stackId, service);
    return row !== undefined;
  }

  getStaleUnknownServices(stackId: string, days: number): string[] {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    return (this.db.prepare(
      `SELECT DISTINCT service FROM service_health_checks
       WHERE stack_id = ? AND service NOT IN (
         SELECT DISTINCT service FROM service_health_checks
         WHERE stack_id = ? AND status != 'unknown' AND checked_at >= ?
       )
       AND service NOT IN (SELECT service FROM hidden_services WHERE stack_id = ?)`
    ).all(stackId, stackId, cutoff, stackId) as Array<{ service: string }>).map(r => r.service);
  }

  // ── Service metadata ────────────────────────────────────────────────────

  private static parseTags(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Migrate service_metadata table and investigation index if they don't exist.
   * Safe to call multiple times — uses CREATE TABLE/INDEX IF NOT EXISTS.
   */
  private migrateServiceMetadata(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_metadata (
        service    TEXT PRIMARY KEY,
        alias      TEXT,
        tags       TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_inv_service_created ON investigations (service, created_at);
    `);
  }

  getServiceMetadata(stackId: string, service: string): ServiceMetadataRow | null {
    const row = this.db.prepare(
      "SELECT service, alias, tags, updated_at FROM service_metadata WHERE stack_id = ? AND service = ?"
    ).get(stackId, service) as { service: string; alias: string | null; tags: string | null; updated_at: string } | undefined;
    if (!row) return null;
    const normalized = normalizeRow(row);
    return {
      service: normalized.service,
      alias: normalized.alias,
      tags: normalized.tags ? Database.parseTags(normalized.tags) : [],
      updated_at: normalized.updated_at,
    };
  }

  upsertServiceMetadata(stackId: string, service: string, updates: { alias?: string; tags?: string[] }): void {
    const alias = updates.alias !== undefined ? updates.alias : null;
    const tags = updates.tags !== undefined ? JSON.stringify(updates.tags) : null;
    this.db.prepare(`
      INSERT INTO service_metadata (stack_id, service, alias, tags, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(stack_id, service) DO UPDATE SET
        alias      = CASE WHEN excluded.alias IS NOT NULL THEN excluded.alias ELSE alias END,
        tags       = CASE WHEN excluded.tags  IS NOT NULL THEN excluded.tags  ELSE tags  END,
        updated_at = datetime('now')
    `).run(stackId, service, alias, tags);
  }

  getAllServiceMetadata(stackId: string): ServiceMetadataRow[] {
    const rows = this.db.prepare(
      "SELECT service, alias, tags, updated_at FROM service_metadata WHERE stack_id = ? ORDER BY service ASC"
    ).all(stackId) as Array<{ service: string; alias: string | null; tags: string | null; updated_at: string }>;
    return rows.map(row => {
      const normalized = normalizeRow(row);
      return {
        service: normalized.service,
        alias: normalized.alias,
        tags: normalized.tags ? Database.parseTags(normalized.tags) : [],
        updated_at: normalized.updated_at,
      };
    });
  }

  /**
   * Check if a recent investigation exists for the given stack+service within a time window.
   * Used by InvestigationDedup as a DB fallback after server restart (when in-memory map is empty).
   */
  hasRecentInvestigation(stackId: string, service: string, windowSeconds: number): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM investigations WHERE stack_id = ? AND service = ? AND created_at > datetime('now', '-' || ? || ' seconds') LIMIT 1"
    ).get(stackId, service, Math.floor(windowSeconds));
    return !!row;
  }

  // ── Settings ──────────────────────────────────────────────────────────

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  close(): void {
    this.db.close();
  }
}

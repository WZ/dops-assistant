import BetterSqlite3 from "better-sqlite3";

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
  }

  createInvestigation(inv: { id: string; service: string; query: string; status: string }): void {
    this.db.prepare("INSERT INTO investigations (id, service, query, status) VALUES (?, ?, ?, ?)").run(inv.id, inv.service, inv.query, inv.status);
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

  getInvestigation(id: string): InvestigationRow | undefined {
    return this.db.prepare(
      "SELECT *, CASE WHEN json_valid(report) THEN json_extract(report, '$.confidenceScore') ELSE NULL END as confidence_score FROM investigations WHERE id = ?"
    ).get(id) as InvestigationRow | undefined;
  }

  listInvestigations(limit: number, offset: number, service?: string): InvestigationRow[] {
    if (service) {
      return this.db.prepare(
        "SELECT *, CASE WHEN json_valid(report) THEN json_extract(report, '$.confidenceScore') ELSE NULL END as confidence_score FROM investigations WHERE service = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?"
      ).all(service, limit, offset) as InvestigationRow[];
    }
    return this.db.prepare(
      "SELECT *, CASE WHEN json_valid(report) THEN json_extract(report, '$.confidenceScore') ELSE NULL END as confidence_score FROM investigations ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?"
    ).all(limit, offset) as InvestigationRow[];
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
    return this.db.prepare("SELECT * FROM investigation_phases WHERE investigation_id = ? ORDER BY started_at ASC").all(investigationId) as PhaseRow[];
  }

  createEvent(event: { id: string; investigationId: string; eventType: string; payload: string }): void {
    this.db.prepare("INSERT INTO investigation_events (id, investigation_id, event_type, payload) VALUES (?, ?, ?, ?)").run(event.id, event.investigationId, event.eventType, event.payload);
  }

  getEvents(investigationId: string): EventRow[] {
    return this.db.prepare("SELECT * FROM investigation_events WHERE investigation_id = ? ORDER BY created_at ASC, rowid ASC").all(investigationId) as EventRow[];
  }

  createMessage(msg: { id: string; role: string; content: string; investigationId?: string; chartData?: string }): void {
    this.db.prepare("INSERT INTO messages (id, investigation_id, role, content, chart_data) VALUES (?, ?, ?, ?, ?)").run(msg.id, msg.investigationId ?? null, msg.role, msg.content, msg.chartData ?? null);
  }

  listRecentMessages(limit: number): MessageRow[] {
    return this.db.prepare(
      "SELECT * FROM (SELECT *, rowid AS _rid FROM messages WHERE investigation_id IS NULL ORDER BY created_at DESC, _rid DESC LIMIT ?) ORDER BY created_at ASC, _rid ASC"
    ).all(limit) as MessageRow[];
  }

  listMessages(limit: number, investigationId?: string): MessageRow[] {
    if (investigationId) {
      return this.db.prepare("SELECT * FROM messages WHERE investigation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?").all(investigationId, limit) as MessageRow[];
    }
    return this.db.prepare(
      "SELECT * FROM (SELECT *, rowid AS _rid FROM messages WHERE investigation_id IS NULL ORDER BY created_at DESC, _rid DESC LIMIT ?) ORDER BY created_at ASC, _rid ASC"
    ).all(limit) as MessageRow[];
  }

  deleteMessage(id: string): boolean {
    const result = this.db.prepare("DELETE FROM messages WHERE id = ? AND investigation_id IS NULL").run(id);
    return result.changes > 0;
  }

  clearConsoleMessages(): number {
    const result = this.db.prepare("DELETE FROM messages WHERE investigation_id IS NULL").run();
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

  getKpiStats(): KpiStats {
    // Investigation counts
    const counts = this.db.prepare(
      `SELECT COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) as active,
        COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) as complete,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
       FROM investigations`
    ).get() as { total: number; active: number; complete: number; failed: number };

    // Success rate (exclude stale-cleanup: failed with no report)
    const completedCount = counts.complete;
    const realFailedCount = (this.db.prepare(
      `SELECT COUNT(*) as c FROM investigations WHERE status = 'failed' AND report IS NOT NULL`
    ).get() as { c: number }).c;
    const successDenom = completedCount + realFailedCount;
    const successRate = successDenom > 0 ? (completedCount / successDenom) * 100 : null;

    // Confidence (from completed investigations, json_valid guard)
    const conf = this.db.prepare(
      `SELECT
        AVG(CASE WHEN json_valid(report) THEN json_extract(report, '$.confidenceScore') ELSE NULL END) as avg,
        COUNT(CASE WHEN json_valid(report) AND json_extract(report, '$.confidenceScore') IS NOT NULL THEN 1 END) as scored,
        COUNT(CASE WHEN json_valid(report) AND json_extract(report, '$.confidenceScore') IS NOT NULL
          AND json_extract(report, '$.confidenceScore') < 0.5 THEN 1 END) as low
       FROM investigations WHERE status = 'complete'`
    ).get() as { avg: number | null; scored: number; low: number };

    // MTTR (7d window + prior 7d for trend)
    const mttr7d = this.db.prepare(
      `SELECT AVG(total_duration_ms) as avg, COUNT(*) as count
       FROM investigations
       WHERE status = 'complete' AND completed_at >= datetime('now', '-7 days')`
    ).get() as { avg: number | null; count: number };

    const mttrPrior = this.db.prepare(
      `SELECT AVG(total_duration_ms) as avg
       FROM investigations
       WHERE status = 'complete'
         AND completed_at >= datetime('now', '-14 days')
         AND completed_at < datetime('now', '-7 days')`
    ).get() as { avg: number | null };

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

  createFeedback(fb: { id: string; investigationId: string; rating: "useful" | "not_useful" }): void {
    this.db.prepare("INSERT INTO investigation_feedback (id, investigation_id, rating) VALUES (?, ?, ?)").run(fb.id, fb.investigationId, fb.rating);
  }

  getFeedback(investigationId: string): { rating: string; created_at: string } | undefined {
    return this.db.prepare("SELECT rating, created_at FROM investigation_feedback WHERE investigation_id = ? ORDER BY created_at DESC LIMIT 1").get(investigationId) as { rating: string; created_at: string } | undefined;
  }

  // ── Incident patterns ───────────────────────────────────────────────────

  createPattern(p: { id: string; service: string; symptom: string; rootCause: string; severity: string; recommendedActions?: string; sourceInvestigationId?: string }): void {
    this.db.prepare(
      "INSERT INTO incident_patterns (id, service, symptom, root_cause, severity, recommended_actions, source_investigation_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(p.id, p.service, p.symptom, p.rootCause, p.severity, p.recommendedActions ?? null, p.sourceInvestigationId ?? null);
  }

  findSimilarPatterns(service: string, limit = 5): Array<{ id: string; service: string; symptom: string; root_cause: string; severity: string; recommended_actions: string | null; created_at: string }> {
    return this.db.prepare(
      "SELECT id, service, symptom, root_cause, severity, recommended_actions, created_at FROM incident_patterns WHERE service = ? ORDER BY created_at DESC LIMIT ?"
    ).all(service, limit) as any[];
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

  insertServiceHealthCheck(service: string, status: string, checkedAt: string): void {
    this.db.prepare(
      "INSERT INTO service_health_checks (service, status, checked_at) VALUES (?, ?, ?)"
    ).run(service, status, checkedAt);
  }

  getServiceHealthHistory(service: string, hours: number): Array<{ status: string; checked_at: string }> {
    // Compute the cutoff timestamp in JS to avoid SQL string concatenation
    const cutoff = new Date(Date.now() - Math.ceil(hours) * 3600 * 1000).toISOString();
    return this.db.prepare(
      `SELECT status, checked_at FROM service_health_checks
       WHERE service = ? AND checked_at >= ?
       ORDER BY checked_at ASC`
    ).all(service, cutoff) as Array<{ status: string; checked_at: string }>;
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

  hideService(service: string, reason?: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO hidden_services (service, reason) VALUES (?, ?)"
    ).run(service, reason ?? null);
  }

  unhideService(service: string): void {
    this.db.prepare("DELETE FROM hidden_services WHERE service = ?").run(service);
  }

  getHiddenServices(): Set<string> {
    const rows = this.db.prepare("SELECT service FROM hidden_services").all() as Array<{ service: string }>;
    return new Set(rows.map(r => r.service));
  }

  getHiddenServiceDetails(): Array<{ service: string; reason: string | null; hidden_at: string }> {
    return this.db.prepare(
      "SELECT service, reason, hidden_at FROM hidden_services ORDER BY hidden_at DESC"
    ).all() as Array<{ service: string; reason: string | null; hidden_at: string }>;
  }

  hideServices(services: string[], reason?: string): void {
    if (services.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO hidden_services (service, reason) VALUES (?, ?)"
    );
    const tx = this.db.transaction((svcs: string[]) => {
      for (const svc of svcs) stmt.run(svc, reason ?? null);
    });
    tx(services);
  }

  isServiceHidden(service: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM hidden_services WHERE service = ?").get(service);
    return row !== undefined;
  }

  getStaleUnknownServices(days: number): string[] {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    return (this.db.prepare(
      `SELECT DISTINCT service FROM service_health_checks
       WHERE service NOT IN (
         SELECT DISTINCT service FROM service_health_checks
         WHERE status != 'unknown' AND checked_at >= ?
       )
       AND service NOT IN (SELECT service FROM hidden_services)`
    ).all(cutoff) as Array<{ service: string }>).map(r => r.service);
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

  getServiceMetadata(service: string): ServiceMetadataRow | null {
    const row = this.db.prepare(
      "SELECT service, alias, tags, updated_at FROM service_metadata WHERE service = ?"
    ).get(service) as { service: string; alias: string | null; tags: string | null; updated_at: string } | undefined;
    if (!row) return null;
    return {
      service: row.service,
      alias: row.alias,
      tags: row.tags ? Database.parseTags(row.tags) : [],
      updated_at: row.updated_at,
    };
  }

  upsertServiceMetadata(service: string, updates: { alias?: string; tags?: string[] }): void {
    const alias = updates.alias !== undefined ? updates.alias : null;
    const tags = updates.tags !== undefined ? JSON.stringify(updates.tags) : null;
    this.db.prepare(`
      INSERT INTO service_metadata (service, alias, tags, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(service) DO UPDATE SET
        alias      = CASE WHEN excluded.alias IS NOT NULL THEN excluded.alias ELSE alias END,
        tags       = CASE WHEN excluded.tags  IS NOT NULL THEN excluded.tags  ELSE tags  END,
        updated_at = datetime('now')
    `).run(service, alias, tags);
  }

  getAllServiceMetadata(): ServiceMetadataRow[] {
    const rows = this.db.prepare(
      "SELECT service, alias, tags, updated_at FROM service_metadata ORDER BY service ASC"
    ).all() as Array<{ service: string; alias: string | null; tags: string | null; updated_at: string }>;
    return rows.map(row => ({
      service: row.service,
      alias: row.alias,
      tags: row.tags ? Database.parseTags(row.tags) : [],
      updated_at: row.updated_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

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
    return this.db.prepare("SELECT * FROM investigations WHERE id = ?").get(id) as InvestigationRow | undefined;
  }

  listInvestigations(limit: number, offset: number): InvestigationRow[] {
    return this.db.prepare("SELECT * FROM investigations ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?").all(limit, offset) as InvestigationRow[];
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
      "SELECT * FROM (SELECT * FROM messages ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC"
    ).all(limit) as MessageRow[];
  }

  listMessages(limit: number, investigationId?: string): MessageRow[] {
    if (investigationId) {
      return this.db.prepare("SELECT * FROM messages WHERE investigation_id = ? ORDER BY created_at ASC LIMIT ?").all(investigationId, limit) as MessageRow[];
    }
    return this.db.prepare("SELECT * FROM messages ORDER BY created_at ASC LIMIT ?").all(limit) as MessageRow[];
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

  close(): void {
    this.db.close();
  }
}

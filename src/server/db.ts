import BetterSqlite3 from "better-sqlite3";

export interface InvestigationRow {
  id: string;
  service: string;
  query: string;
  status: string;
  report: string | null;
  created_at: string;
  completed_at: string | null;
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
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS investigation_events (
        id                TEXT PRIMARY KEY,
        investigation_id  TEXT NOT NULL REFERENCES investigations(id),
        event_type        TEXT NOT NULL,
        payload           TEXT NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  createInvestigation(inv: { id: string; service: string; query: string; status: string }): void {
    this.db.prepare("INSERT INTO investigations (id, service, query, status) VALUES (?, ?, ?, ?)").run(inv.id, inv.service, inv.query, inv.status);
  }

  updateInvestigation(id: string, updates: { status?: string; report?: string; completed_at?: string }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (updates.status !== undefined) { sets.push("status = ?"); vals.push(updates.status); }
    if (updates.report !== undefined) { sets.push("report = ?"); vals.push(updates.report); }
    if (updates.completed_at !== undefined) { sets.push("completed_at = ?"); vals.push(updates.completed_at); }
    else if (updates.status === "complete" || updates.status === "failed") { sets.push("completed_at = datetime('now')"); }
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

  createMessage(msg: { id: string; role: string; content: string; investigationId?: string }): void {
    this.db.prepare("INSERT INTO messages (id, investigation_id, role, content) VALUES (?, ?, ?, ?)").run(msg.id, msg.investigationId ?? null, msg.role, msg.content);
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

  close(): void {
    this.db.close();
  }
}

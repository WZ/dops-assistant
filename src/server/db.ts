import BetterSqlite3 from "better-sqlite3";
import type { StackRow } from "../types/stack-types.js";
import type { SeverityLevel, NotificationSource, EmailRecipient } from "../types/notifications.js";
import { ALL_SEVERITIES, ALL_SOURCES } from "../types/notifications.js";
import { createLogger as _createLoggerForRecipientParser } from "../logger.js";
const _emailRecipientLogger = _createLoggerForRecipientParser();

/**
 * Defensive parse for the `allowed_sources` column. The column stores a JSON
 * array of NotificationSource strings. If the JSON is corrupt, not an array,
 * or contains unknown values, we log and return an empty array. An empty
 * `allowedSources` makes the recipient unreachable by `notifyEmail`'s filter,
 * which fails closed (no notification sent) rather than silently misrouting.
 */
function parseAllowedSources(raw: string, recipientId: number): NotificationSource[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      _emailRecipientLogger.warn({ recipientId, raw }, "email_recipients.allowed_sources is not an array; treating as empty");
      return [];
    }
    const out: NotificationSource[] = [];
    for (const x of parsed) {
      if (typeof x === "string" && (ALL_SOURCES as readonly string[]).includes(x)) {
        out.push(x as NotificationSource);
      } else {
        _emailRecipientLogger.warn({ recipientId, value: x }, "email_recipients.allowed_sources contains unknown source; skipping");
      }
    }
    return out;
  } catch (err) {
    _emailRecipientLogger.error({ err, recipientId, raw }, "email_recipients.allowed_sources is not valid JSON; treating as empty");
    return [];
  }
}

/**
 * Defensive cast for the `min_severity` column. Invalid values fall back to
 * "critical" — the strictest threshold — so unknown input fails closed
 * (the recipient sees nothing rather than being silently widened to everything).
 */
function parseMinSeverity(raw: string, recipientId: number): SeverityLevel {
  if ((ALL_SEVERITIES as readonly string[]).includes(raw)) return raw as SeverityLevel;
  _emailRecipientLogger.warn({ recipientId, raw }, "email_recipients.min_severity is unknown; defaulting to critical");
  return "critical";
}

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
  severity: Severity | null;
}

export type Severity = "critical" | "high" | "medium" | "low";
const VALID_SEVERITIES: ReadonlySet<Severity> = new Set(["critical", "high", "medium", "low"]);

/**
 * Canonicalize a report's severity value into the enum set, or null if the
 * report is unparseable or the severity is missing/invalid. Shared by the
 * backfill migration and the updateInvestigation write path so that the
 * severity column never contains stray values like "Critical" or "HIGH".
 */
export function severityOf(reportJson: string | null | undefined): Severity | null {
  if (!reportJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = (parsed as { severity?: unknown }).severity;
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toLowerCase();
  return VALID_SEVERITIES.has(norm as Severity) ? (norm as Severity) : null;
}

export interface InvestigationFilters {
  limit?: number;
  offset?: number;
  /** Exact match. Retained for backward compat with existing per-service callers. */
  service?: string;
  /** OR semantics within the array. */
  severity?: Severity[];
  /** OR semantics within the array. */
  status?: string[];
  /**
   * ISO-8601 timestamps. Wrapped with SQLite's datetime() in the WHERE clause
   * so they compare correctly against created_at (which stores the
   * datetime('now') format, NOT ISO). Direct lexical comparison would silently
   * return wrong rows.
   */
  since?: string;
  until?: string;
  /** Case-insensitive substring match across service, query, report.summary, report.rootCause. */
  q?: string;
  sort?: "created_at" | "confidence";
}

/**
 * Escape the three special LIKE chars (%, _, \) so user input in `q` matches
 * literally instead of being interpreted as wildcards. Paired with
 * `ESCAPE '\\'` in the SQL fragment.
 */
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Build the shared WHERE clause + bind array used by listInvestigations and
 * countInvestigations. Centralizing this keeps the two queries in lockstep —
 * any new filter automatically affects both the visible rows and the total
 * count with no drift risk.
 */
function buildInvestigationsWhere(
  stackId: string,
  filters: InvestigationFilters,
): { sql: string; binds: unknown[] } {
  const clauses: string[] = ["stack_id = ?"];
  const binds: unknown[] = [stackId];
  if (filters.service) {
    clauses.push("service = ?");
    binds.push(filters.service);
  }
  if (filters.severity && filters.severity.length > 0) {
    clauses.push(`severity IN (${filters.severity.map(() => "?").join(",")})`);
    binds.push(...filters.severity);
  }
  if (filters.status && filters.status.length > 0) {
    clauses.push(`status IN (${filters.status.map(() => "?").join(",")})`);
    binds.push(...filters.status);
  }
  if (filters.since) {
    clauses.push("created_at >= datetime(?)");
    binds.push(filters.since);
  }
  if (filters.until) {
    clauses.push("created_at <= datetime(?)");
    binds.push(filters.until);
  }
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    // Guard json_extract with json_valid: SQLite throws on malformed JSON, so
    // one bad historical row would 500 every q search. json_valid returns 0
    // for non-JSON / malformed, cleanly excluding those rows from the match.
    clauses.push(
      "(service LIKE ? ESCAPE '\\' " +
      "OR query LIKE ? ESCAPE '\\' " +
      "OR (report IS NOT NULL AND json_valid(report) AND COALESCE(json_extract(report, '$.summary'), '') LIKE ? ESCAPE '\\') " +
      "OR (report IS NOT NULL AND json_valid(report) AND COALESCE(json_extract(report, '$.rootCause'), '') LIKE ? ESCAPE '\\'))",
    );
    binds.push(pattern, pattern, pattern, pattern);
  }
  return { sql: clauses.join(" AND "), binds };
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

export interface ScanRunRow {
  id: string;
  stackId: string;
  trigger: "manual" | "cron";
  status: "running" | "complete" | "failed" | "skipped";
  skipReason: string | null;
  startedAt: number;
  finishedAt: number | null;
  servicesProbed: number;
  rulesApplied: number;
  queriesExecuted: number;
  probeErrors: number;
  queriesEmpty: number;
  probeDurationMs: number | null;
  probeDetailJson: string | null;
  hitsRaw: number;
  hitsAfterDedup: number;
  hitsDispatched: number;
  droppedByCap: number;
  triageDetailJson: string | null;
  errorMessage: string | null;
  createdAt: number;
}

export interface ScanRunInvestigationRow {
  scanRunId: string;
  investigationId: string;
  service: string;
  ruleName: string;
  value: number;
  severity: number;
  dispatchedAt: number;
}

export interface InsertScanRunInput {
  id: string;
  stackId: string;
  trigger: "manual" | "cron";
  startedAt: number;
}

export interface UpdateScanRunInput {
  status?: "complete" | "failed" | "skipped";
  skipReason?: string | null;
  finishedAt?: number;
  servicesProbed?: number;
  rulesApplied?: number;
  queriesExecuted?: number;
  probeErrors?: number;
  queriesEmpty?: number;
  probeDurationMs?: number;
  probeDetailJson?: string;
  hitsRaw?: number;
  hitsAfterDedup?: number;
  hitsDispatched?: number;
  droppedByCap?: number;
  triageDetailJson?: string;
  errorMessage?: string | null;
}

/**
 * Converts a raw snake_case row from `scan_runs` into the camelCase
 * `ScanRunRow` used by callers. Timestamps stay as epoch-millisecond numbers
 * (scan_runs stores INTEGERs, not SQLite datetime strings) so no
 * normalizeTimestamp() conversion is needed here.
 */
function scanRunFromDbRow(r: Record<string, unknown>): ScanRunRow {
  return {
    id: r["id"] as string,
    stackId: r["stack_id"] as string,
    trigger: r["trigger"] as "manual" | "cron",
    status: r["status"] as ScanRunRow["status"],
    skipReason: (r["skip_reason"] as string | null) ?? null,
    startedAt: r["started_at"] as number,
    finishedAt: (r["finished_at"] as number | null) ?? null,
    servicesProbed: r["services_probed"] as number,
    rulesApplied: r["rules_applied"] as number,
    queriesExecuted: r["queries_executed"] as number,
    probeErrors: r["probe_errors"] as number,
    // Column added in a later migration; pre-existing rows default to 0.
    queriesEmpty: (r["queries_empty"] as number | null) ?? 0,
    probeDurationMs: (r["probe_duration_ms"] as number | null) ?? null,
    probeDetailJson: (r["probe_detail_json"] as string | null) ?? null,
    hitsRaw: r["hits_raw"] as number,
    hitsAfterDedup: r["hits_after_dedup"] as number,
    hitsDispatched: r["hits_dispatched"] as number,
    droppedByCap: r["dropped_by_cap"] as number,
    triageDetailJson: (r["triage_detail_json"] as string | null) ?? null,
    errorMessage: (r["error_message"] as string | null) ?? null,
    createdAt: r["created_at"] as number,
  };
}

export class Database {
  private db: BetterSqlite3.Database;

  constructor(path: string) {
    this.db = new BetterSqlite3(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.migrateServiceMetadata();
    this.migrateStacks();
    this.migrateDisabledSkills();
    this.migrateEmailRecipients();
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
    try { this.db.exec("ALTER TABLE investigations ADD COLUMN severity TEXT"); } catch {}
    try { this.db.exec("CREATE INDEX IF NOT EXISTS idx_inv_stack_sev_created ON investigations (stack_id, severity, created_at DESC)"); } catch {}
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
    this.migrateScanRuns();
    this.migrateInvestigationSeverity();
  }

  /**
   * One-shot backfill: populate the new `severity` column for rows where it
   * was never written (historical rows from before the column existed).
   *
   * Runs on every boot but is cheap after convergence — the WHERE clause
   * matches zero rows once every investigation has been processed. Uses a
   * transaction so the full backfill is atomic: either everything or nothing.
   */
  private migrateInvestigationSeverity(): void {
    const rows = this.db.prepare(
      "SELECT id, report FROM investigations WHERE severity IS NULL AND report IS NOT NULL"
    ).all() as Array<{ id: string; report: string | null }>;
    if (rows.length === 0) return;
    const stmt = this.db.prepare("UPDATE investigations SET severity = ? WHERE id = ?");
    const tx = this.db.transaction((batch: typeof rows) => {
      for (const row of batch) {
        const sev = severityOf(row.report);
        if (sev !== null) stmt.run(sev, row.id);
      }
    });
    tx(rows);
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

  // ── Scan runs migration ────────────────────────────────────────────────

  private migrateScanRuns(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scan_runs (
        id                  TEXT    PRIMARY KEY,
        stack_id            TEXT    NOT NULL,
        trigger             TEXT    NOT NULL,
        status              TEXT    NOT NULL,
        skip_reason         TEXT,
        -- Timestamps on scan_runs are epoch milliseconds (not SQLite datetime strings).
        -- All *_at columns on this table follow the same convention.
        started_at          INTEGER NOT NULL,
        finished_at         INTEGER,
        services_probed     INTEGER NOT NULL DEFAULT 0,
        rules_applied       INTEGER NOT NULL DEFAULT 0,
        queries_executed    INTEGER NOT NULL DEFAULT 0,
        probe_errors        INTEGER NOT NULL DEFAULT 0,
        queries_empty       INTEGER NOT NULL DEFAULT 0,
        probe_duration_ms   INTEGER,
        probe_detail_json   TEXT,
        hits_raw            INTEGER NOT NULL DEFAULT 0,
        hits_after_dedup    INTEGER NOT NULL DEFAULT 0,
        hits_dispatched     INTEGER NOT NULL DEFAULT 0,
        dropped_by_cap      INTEGER NOT NULL DEFAULT 0,
        triage_detail_json  TEXT,
        error_message       TEXT,
        created_at          INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      );

      CREATE INDEX IF NOT EXISTS scan_runs_stack_started ON scan_runs(stack_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS scan_runs_status        ON scan_runs(status);

      CREATE TABLE IF NOT EXISTS scan_run_investigations (
        scan_run_id      TEXT NOT NULL,
        investigation_id TEXT NOT NULL,
        service          TEXT NOT NULL,
        rule_name        TEXT NOT NULL,
        value            REAL NOT NULL,
        severity         REAL NOT NULL,
        dispatched_at    INTEGER NOT NULL,
        PRIMARY KEY (scan_run_id, investigation_id),
        -- ON DELETE CASCADE is declarative only (PRAGMA foreign_keys is OFF in this project).
        -- Actual cascade is performed by deleteStack() sweeping this table explicitly.
        FOREIGN KEY (scan_run_id) REFERENCES scan_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS scan_run_inv_by_inv ON scan_run_investigations(investigation_id);
    `);

    // Additive migration: split the old `probe_errors` counter into real
    // failures vs empty vectors. Existing rows default to 0 and will look
    // the same in the UI until the next scan tick writes real numbers.
    const addEmptyCol = "ALTER TABLE scan_runs ADD COLUMN queries_empty INTEGER NOT NULL DEFAULT 0";
    try { this.db.exec(addEmptyCol); } catch { /* column already exists */ }
  }

  // ── Email recipients migration ─────────────────────────────────────────

  private migrateEmailRecipients(): void {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS email_recipients (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        address          TEXT NOT NULL,
        label            TEXT,
        min_severity     TEXT NOT NULL DEFAULT 'high',
        allowed_sources  TEXT NOT NULL DEFAULT '["webhook","scan","poller"]',
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
    this.db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_email_recipients_enabled ON email_recipients(enabled)`
    ).run();
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

    // TTL columns — additive, idempotent. `last_active_at` bumps on any
    // activity (tool calls, successful polls, webhook, UI navigation).
    // After 30d idle we set `inactive_at` (UI badge); after 60d idle we
    // set `deleted_at` (soft-delete — excluded from listings but kept in
    // DB so the user can audit / restore).
    const stacksInfo = this.db.prepare("PRAGMA table_info(stacks)").all() as Array<{ name: string }>;
    const hasLastActive = stacksInfo.some(c => c.name === "last_active_at");
    const hasInactive = stacksInfo.some(c => c.name === "inactive_at");
    const hasDeleted = stacksInfo.some(c => c.name === "deleted_at");
    if (!hasLastActive) {
      this.db.exec("ALTER TABLE stacks ADD COLUMN last_active_at TEXT");
      // Backfill existing rows so TTL math is well-defined.
      this.db.prepare(
        "UPDATE stacks SET last_active_at = created_at WHERE last_active_at IS NULL"
      ).run();
    }
    if (!hasInactive) {
      this.db.exec("ALTER TABLE stacks ADD COLUMN inactive_at TEXT");
    }
    if (!hasDeleted) {
      this.db.exec("ALTER TABLE stacks ADD COLUMN deleted_at TEXT");
    }

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

    // Lane B Step 4 — add scan_override column for per-service probe overrides.
    // Stored as JSON text (ScanServiceOverride shape) or NULL. Idempotent; runs
    // after the composite-PK migration above so metaInfoPost reflects final schema.
    const metaInfoPost = this.db.prepare("PRAGMA table_info(service_metadata)").all() as Array<{ name: string }>;
    if (!metaInfoPost.some(col => col.name === "scan_override")) {
      this.db.prepare("ALTER TABLE service_metadata ADD COLUMN scan_override TEXT").run();
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
    // last_active_at defaults to now — matches the invariant that every new
    // stack is "fresh" and won't hit the 30d inactive threshold immediately.
    this.db.prepare(
      "INSERT INTO stacks (id, name, slug, config, last_active_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(stack.id, stack.name, stack.slug, stack.config);
  }

  getStack(id: string): StackRow | undefined {
    // Exclude soft-deleted stacks from the default lookup path. Callers that
    // need to see soft-deleted rows (audit / restore) can query directly.
    return this.db.prepare(
      "SELECT * FROM stacks WHERE id = ? AND deleted_at IS NULL"
    ).get(id) as StackRow | undefined;
  }

  getStackBySlug(slug: string): StackRow | undefined {
    return this.db.prepare(
      "SELECT * FROM stacks WHERE slug = ? AND deleted_at IS NULL"
    ).get(slug) as StackRow | undefined;
  }

  /**
   * List all stacks that are NOT soft-deleted. Returns active + inactive.
   * Use `listStacksIncludingDeleted` to see everything.
   */
  listStacks(): StackRow[] {
    return this.db.prepare(
      "SELECT * FROM stacks WHERE deleted_at IS NULL ORDER BY created_at ASC"
    ).all() as StackRow[];
  }

  /**
   * Escape hatch for admin views — returns every stack row, including those
   * soft-deleted by the TTL reaper. Not used by the default /api/stacks
   * listing.
   */
  listStacksIncludingDeleted(): StackRow[] {
    return this.db.prepare(
      "SELECT * FROM stacks ORDER BY created_at ASC"
    ).all() as StackRow[];
  }

  /**
   * Update `last_active_at` to now. Called on every tool-call, successful
   * poll cycle, webhook invocation, and UI navigation to the stack. Cheap
   * enough to call often (single UPDATE by PK) — the alternative of batching
   * risks losing activity signal across server restarts.
   *
   * Also clears `inactive_at` if set, so a resurrected stack transitions
   * back to "active" immediately instead of waiting for the next reaper run.
   */
  bumpStackActivity(id: string): void {
    this.db.prepare(
      "UPDATE stacks SET last_active_at = datetime('now'), inactive_at = NULL WHERE id = ? AND deleted_at IS NULL"
    ).run(id);
  }

  /**
   * Run the TTL reaper. Stacks idle for `inactiveAfterDays` are marked
   * inactive; stacks idle for `deleteAfterDays` are soft-deleted. The
   * default stack is exempted — deleting the default would orphan the
   * server.
   *
   * Returns a summary of how many rows transitioned so callers can log it.
   * Idempotent: already-inactive or already-deleted rows are untouched.
   */
  runStackTtlReaper(opts: {
    defaultStackId: string;
    inactiveAfterDays: number;
    deleteAfterDays: number;
    /** Optional "now" for tests; defaults to real time. */
    nowIso?: string;
  }): { markedInactive: number; softDeleted: number } {
    const now = opts.nowIso ?? new Date().toISOString();
    const inactiveCutoff = new Date(new Date(now).getTime() - opts.inactiveAfterDays * 24 * 3600 * 1000).toISOString();
    const deleteCutoff = new Date(new Date(now).getTime() - opts.deleteAfterDays * 24 * 3600 * 1000).toISOString();

    // Soft-delete first: a stack that crosses the delete threshold was
    // already past the inactive threshold; skipping the inactive mark for
    // it would be fine, but setting it doesn't hurt either.
    const deleted = this.db.prepare(
      `UPDATE stacks
          SET deleted_at = ?
        WHERE id != ?
          AND deleted_at IS NULL
          AND last_active_at IS NOT NULL
          AND last_active_at < ?`
    ).run(now, opts.defaultStackId, deleteCutoff);

    const inactive = this.db.prepare(
      `UPDATE stacks
          SET inactive_at = ?
        WHERE id != ?
          AND deleted_at IS NULL
          AND inactive_at IS NULL
          AND last_active_at IS NOT NULL
          AND last_active_at < ?`
    ).run(now, opts.defaultStackId, inactiveCutoff);

    return { markedInactive: inactive.changes, softDeleted: deleted.changes };
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
      // Scan runs (and cascade to scan_run_investigations — FK cascade is declarative-only)
      this.db.prepare("DELETE FROM scan_run_investigations WHERE scan_run_id IN (SELECT id FROM scan_runs WHERE stack_id = ?)").run(id);
      this.db.prepare("DELETE FROM scan_runs WHERE stack_id = ?").run(id);
      this.db.prepare("DELETE FROM service_metadata WHERE stack_id = ?").run(id);
      this.db.prepare("DELETE FROM hidden_services WHERE stack_id = ?").run(id);
      this.db.prepare("DELETE FROM disabled_skills WHERE stack_id = ?").run(id);
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
    if (updates.report !== undefined) {
      sets.push("report = ?"); vals.push(updates.report);
      // Extract the canonical severity so it's always in sync with the stored
      // report. Invalid/missing severities become NULL, never "Critical" or a
      // stale leftover from a prior write.
      sets.push("severity = ?"); vals.push(severityOf(updates.report));
    }
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

  listInvestigations(stackId: string, filters: InvestigationFilters = {}): InvestigationRow[] {
    // Internal safety cap at 10k — the HTTP layer has its own stricter 100-row
    // cap (see parseInvestigationFilters). Non-HTTP callers like rca-eval need
    // the headroom to pull a full stack's history.
    const limit = Math.max(1, Math.min(filters.limit ?? 25, 10_000));
    const offset = Math.max(0, filters.offset ?? 0);
    const sortCol = filters.sort === "confidence" ? "confidence_score" : "created_at";
    const { sql: where, binds } = buildInvestigationsWhere(stackId, filters);
    const stmt = this.db.prepare(
      `SELECT *,
         CASE WHEN json_valid(report) THEN json_extract(report, '$.confidenceScore') ELSE NULL END AS confidence_score
       FROM investigations
       WHERE ${where}
       ORDER BY ${sortCol} DESC, rowid DESC
       LIMIT ? OFFSET ?`
    );
    return (stmt.all(...binds, limit, offset) as InvestigationRow[]).map(normalizeRow);
  }

  /**
   * Return the total count of investigations matching the same filters as
   * listInvestigations, ignoring limit/offset. Used by the /investigations
   * page to render "N of M match filters" and drive pagination.
   */
  countInvestigations(stackId: string, filters: InvestigationFilters = {}): number {
    const { sql: where, binds } = buildInvestigationsWhere(stackId, filters);
    const row = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM investigations WHERE ${where}`
    ).get(...binds) as { cnt: number };
    return row.cnt;
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

  // ── Disabled skills (per-stack) ─────────────────────────────────────────

  private migrateDisabledSkills(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS disabled_skills (
        stack_id    TEXT NOT NULL,
        skill_id    TEXT NOT NULL,
        disabled_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (stack_id, skill_id)
      );
    `);
  }

  disableSkill(stackId: string, skillId: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO disabled_skills (stack_id, skill_id) VALUES (?, ?)"
    ).run(stackId, skillId);
  }

  enableSkill(stackId: string, skillId: string): void {
    this.db.prepare("DELETE FROM disabled_skills WHERE stack_id = ? AND skill_id = ?").run(stackId, skillId);
  }

  getDisabledSkills(stackId: string): Set<string> {
    const rows = this.db.prepare("SELECT skill_id FROM disabled_skills WHERE stack_id = ?").all(stackId) as Array<{ skill_id: string }>;
    return new Set(rows.map(r => r.skill_id));
  }

  isSkillDisabled(stackId: string, skillId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM disabled_skills WHERE stack_id = ? AND skill_id = ?").get(stackId, skillId);
    return row !== undefined;
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

  /**
   * Per-service scan override — the effective override shape for a service.
   * Null means "no override" (use global rules). Caller is responsible for
   * the JSON schema of the value; we just store + retrieve the string.
   */
  getScanOverride(stackId: string, service: string): string | null {
    const row = this.db.prepare(
      "SELECT scan_override FROM service_metadata WHERE stack_id = ? AND service = ?"
    ).get(stackId, service) as { scan_override: string | null } | undefined;
    return row?.scan_override ?? null;
  }

  /**
   * Set the per-service scan override JSON. Upserts the metadata row if
   * none exists yet (symmetric with `upsertServiceMetadata`).
   */
  setScanOverride(stackId: string, service: string, overrideJson: string): void {
    this.db.prepare(`
      INSERT INTO service_metadata (stack_id, service, scan_override, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(stack_id, service) DO UPDATE SET
        scan_override = excluded.scan_override,
        updated_at    = datetime('now')
    `).run(stackId, service, overrideJson);
  }

  /**
   * Clear the override, reverting the service to global rules. NULLs out the
   * column without deleting the metadata row (which may still hold alias/tags).
   */
  clearScanOverride(stackId: string, service: string): void {
    this.db.prepare(`
      UPDATE service_metadata
      SET scan_override = NULL, updated_at = datetime('now')
      WHERE stack_id = ? AND service = ?
    `).run(stackId, service);
  }

  /**
   * Map of { service → overrideJson } for every service in a stack that has
   * a non-null scan_override. Used by the scheduler to pass a cheap lookup
   * into anomaly-probe without hitting the DB once per service per tick.
   */
  getAllScanOverrides(stackId: string): Record<string, string> {
    const rows = this.db.prepare(
      "SELECT service, scan_override FROM service_metadata WHERE stack_id = ? AND scan_override IS NOT NULL"
    ).all(stackId) as Array<{ service: string; scan_override: string }>;
    const out: Record<string, string> = {};
    for (const row of rows) out[row.service] = row.scan_override;
    return out;
  }

  /**
   * Explicitly clear a service's alias (sets alias column to NULL).
   * `upsertServiceMetadata` treats `null` as "don't change this column" to
   * support partial updates, so there's no way to clear via that path. This
   * method is for the PUT /alias handler when the client sends `null`.
   */
  clearServiceAlias(stackId: string, service: string): void {
    this.db.prepare(`
      INSERT INTO service_metadata (stack_id, service, alias, tags, updated_at)
      VALUES (?, ?, NULL, NULL, datetime('now'))
      ON CONFLICT(stack_id, service) DO UPDATE SET
        alias      = NULL,
        updated_at = datetime('now')
    `).run(stackId, service);
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

  /**
   * Count scan-triggered investigations on this stack within a time window.
   * Used by the Dashboard activity badge to show "N anomalies in last 24h".
   *
   * "Scan-triggered" is identified by the stable message prefix written by
   * `buildInvestigationMessage()` in anomaly-probe.ts — kept in lockstep with
   * `classifyTriggerSource()` in rca-eval.ts. If the prefix ever changes,
   * BOTH must update (tested via shared fixtures in rca-eval.test.ts).
   *
   * Counts only investigations with `status = 'complete'` — pending/running
   * shouldn't inflate the "anomalies found" number the operator sees.
   */
  countScanTriggeredInvestigationsSince(stackId: string, sinceIso: string): number {
    // `created_at` is stored in SQLite's datetime('now') format — space-separated,
    // no 'T', no 'Z'. An ISO-8601 input string compared directly fails lexically
    // ("2026-04-22 06:00:00" < "2026-04-22T05:00:00.000Z" because ' ' < 'T').
    // `datetime(?)` parses the ISO input into the same format before comparison.
    const row = this.db.prepare(
      "SELECT COUNT(*) as n FROM investigations " +
        "WHERE stack_id = ? " +
        "AND query LIKE 'Proactive scan detected anomaly%' " +
        "AND status = 'complete' " +
        "AND created_at >= datetime(?)"
    ).get(stackId, sinceIso) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Epoch ms of the most recent COMPLETED investigation for this stack+service,
   * or null if none. Used by the scan scheduler's per-tick prioritization
   * ("oldest last-investigated wins" tiebreak when more services trip than
   * `maxInvestigationsPerTick`).
   *
   * Only `status = 'complete'` counts. Failed and in-progress ('running',
   * 'pending') are excluded — otherwise a stuck-running investigation would
   * permanently pin its service at "most recently investigated," starving
   * it from scan prioritization forever.
   *
   * Uses SQLite `strftime('%s', ...)` to convert the `created_at` TEXT column
   * to a Unix timestamp — Date.parse() on SQLite's space-separated datetime
   * format is implementation-defined (can yield NaN or local-time) and is
   * unsafe for cross-runtime comparisons.
   */
  getLastInvestigationAt(stackId: string, service: string): number | null {
    const row = this.db.prepare(
      "SELECT CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS ms FROM investigations WHERE stack_id = ? AND service = ? AND status = 'complete' ORDER BY created_at DESC LIMIT 1"
    ).get(stackId, service) as { ms: number } | undefined;
    return row?.ms ?? null;
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

  /**
   * Run a function inside a SQLite transaction. Writes commit atomically;
   * throws anywhere inside `fn` roll everything back. Delegates to
   * better-sqlite3's `transaction()` which runs synchronously and is
   * re-entrant-safe.
   *
   * Use for multi-write operations where partial state corrupts invariants
   * (e.g., PUT /api/scan/settings writing cron + rules + enabled together —
   * if one fails, the effective config is incoherent).
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── Email recipients ──────────────────────────────────────────────────────

  createEmailRecipient(input: {
    address: string;
    label?: string;
    minSeverity: SeverityLevel;
    allowedSources: NotificationSource[];
    enabled: boolean;
  }): EmailRecipient {
    const result = this.db.prepare(
      `INSERT INTO email_recipients (address, label, min_severity, allowed_sources, enabled)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      input.address,
      input.label ?? null,
      input.minSeverity,
      JSON.stringify(input.allowedSources),
      input.enabled ? 1 : 0,
    );
    const id = Number(result.lastInsertRowid);
    return this.getEmailRecipient(id)!;
  }

  getEmailRecipient(id: number): EmailRecipient | undefined {
    const row = this.db.prepare(
      `SELECT id, address, label, min_severity, allowed_sources, enabled, created_at, updated_at
       FROM email_recipients WHERE id = ?`
    ).get(id) as {
      id: number; address: string; label: string | null;
      min_severity: string; allowed_sources: string; enabled: number;
      created_at: string; updated_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      address: row.address,
      label: row.label ?? undefined,
      minSeverity: parseMinSeverity(row.min_severity, row.id),
      allowedSources: parseAllowedSources(row.allowed_sources, row.id),
      enabled: row.enabled === 1,
      createdAt: normalizeTimestamp(row.created_at),
      updatedAt: normalizeTimestamp(row.updated_at),
    };
  }

  listEmailRecipients(opts?: { enabledOnly?: boolean }): EmailRecipient[] {
    const sql = opts?.enabledOnly
      ? `SELECT id, address, label, min_severity, allowed_sources, enabled, created_at, updated_at
         FROM email_recipients WHERE enabled = 1 ORDER BY id`
      : `SELECT id, address, label, min_severity, allowed_sources, enabled, created_at, updated_at
         FROM email_recipients ORDER BY id`;
    const rows = this.db.prepare(sql).all() as Array<{
      id: number; address: string; label: string | null;
      min_severity: string; allowed_sources: string; enabled: number;
      created_at: string; updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      address: row.address,
      label: row.label ?? undefined,
      minSeverity: parseMinSeverity(row.min_severity, row.id),
      allowedSources: parseAllowedSources(row.allowed_sources, row.id),
      enabled: row.enabled === 1,
      createdAt: normalizeTimestamp(row.created_at),
      updatedAt: normalizeTimestamp(row.updated_at),
    }));
  }

  updateEmailRecipient(id: number, patch: {
    address?: string;
    label?: string | null;
    minSeverity?: SeverityLevel;
    allowedSources?: NotificationSource[];
    enabled?: boolean;
  }): EmailRecipient | undefined {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.address !== undefined) { fields.push("address = ?"); values.push(patch.address); }
    if (patch.label !== undefined) { fields.push("label = ?"); values.push(patch.label); }
    if (patch.minSeverity !== undefined) { fields.push("min_severity = ?"); values.push(patch.minSeverity); }
    if (patch.allowedSources !== undefined) { fields.push("allowed_sources = ?"); values.push(JSON.stringify(patch.allowedSources)); }
    if (patch.enabled !== undefined) { fields.push("enabled = ?"); values.push(patch.enabled ? 1 : 0); }
    if (fields.length === 0) return this.getEmailRecipient(id);
    fields.push("updated_at = datetime('now', 'subsec')");
    values.push(id);
    this.db.prepare(`UPDATE email_recipients SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getEmailRecipient(id);
  }

  deleteEmailRecipient(id: number): void {
    this.db.prepare("DELETE FROM email_recipients WHERE id = ?").run(id);
  }

  // ── Scan runs ────────────────────────────────────────────────────────────

  /**
   * Insert a new scan_run row in the "running" state. Probe/triage stats,
   * finishedAt, and terminal status are applied later via updateScanRun().
   */
  insertScanRun(input: InsertScanRunInput): void {
    this.db.prepare(`
      INSERT INTO scan_runs (id, stack_id, trigger, status, started_at)
      VALUES (?, ?, ?, 'running', ?)
    `).run(input.id, input.stackId, input.trigger, input.startedAt);
  }

  /**
   * Partial update for a scan_run. Builds a dynamic SET clause from the
   * defined keys in `patch`; undefined keys are skipped so callers can apply
   * only the fields they care about (e.g., just probe stats, or just final
   * triage counts). No-ops when the patch is empty.
   */
  updateScanRun(id: string, patch: UpdateScanRunInput): void {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const map: Record<keyof UpdateScanRunInput, string> = {
      status: "status",
      skipReason: "skip_reason",
      finishedAt: "finished_at",
      servicesProbed: "services_probed",
      rulesApplied: "rules_applied",
      queriesExecuted: "queries_executed",
      probeErrors: "probe_errors",
      queriesEmpty: "queries_empty",
      probeDurationMs: "probe_duration_ms",
      probeDetailJson: "probe_detail_json",
      hitsRaw: "hits_raw",
      hitsAfterDedup: "hits_after_dedup",
      hitsDispatched: "hits_dispatched",
      droppedByCap: "dropped_by_cap",
      triageDetailJson: "triage_detail_json",
      errorMessage: "error_message",
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      cols.push(`${map[k as keyof UpdateScanRunInput]} = ?`);
      vals.push(v);
    }
    if (cols.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE scan_runs SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  }

  /**
   * Fetch a single scan_run scoped to its stack. Returning null on a
   * stack_id mismatch (rather than the row from the wrong stack) enforces
   * cross-stack isolation — callers must not see another tenant's runs even
   * if they guess the ID.
   */
  getScanRun(stackId: string, id: string): ScanRunRow | null {
    const row = this.db.prepare(`
      SELECT * FROM scan_runs WHERE stack_id = ? AND id = ?
    `).get(stackId, id) as Record<string, unknown> | undefined;
    return row ? scanRunFromDbRow(row) : null;
  }

  /**
   * Look up a scan_run row WITHOUT stack filtering. Used solely by the
   * GET /api/scan/runs/:id handler to produce a "wrong stack" 404 hint —
   * do NOT expose this to cross-stack callers elsewhere.
   */
  getScanRunAnyStack(id: string): ScanRunRow | null {
    const row = this.db.prepare(`SELECT * FROM scan_runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? scanRunFromDbRow(row) : null;
  }

  /**
   * List scan_runs for a stack, newest first. `before` is an epoch-ms
   * cursor: only rows with started_at strictly less than it are returned.
   */
  listScanRuns(opts: { stackId: string; limit: number; before?: number }): ScanRunRow[] {
    const where = opts.before !== undefined
      ? "stack_id = ? AND started_at < ?"
      : "stack_id = ?";
    const args = opts.before !== undefined ? [opts.stackId, opts.before] : [opts.stackId];
    const rows = this.db.prepare(`
      SELECT * FROM scan_runs WHERE ${where}
      ORDER BY started_at DESC LIMIT ?
    `).all(...args, opts.limit) as Record<string, unknown>[];
    return rows.map(scanRunFromDbRow);
  }

  /**
   * Record the investigation dispatched from a scan_run hit. Idempotent:
   * the composite PK (scan_run_id, investigation_id) + INSERT OR IGNORE
   * means repeated calls for the same pair are a no-op. Stored metadata
   * (service, ruleName, value, severity) is the snapshot at dispatch time.
   */
  linkScanRunInvestigation(
    scanRunId: string,
    investigationId: string,
    hit: { service: string; ruleName: string; value: number; severity: number; dispatchedAt: number },
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO scan_run_investigations
        (scan_run_id, investigation_id, service, rule_name, value, severity, dispatched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(scanRunId, investigationId, hit.service, hit.ruleName, hit.value, hit.severity, hit.dispatchedAt);
  }

  /**
   * Mark any `scan_runs` row stuck in 'running' as 'failed'. Called at server
   * startup — if the previous process died mid-tick, its row stays 'running'
   * forever. Idempotent; safe to call on every boot.
   */
  sweepStaleScanRuns(): void {
    this.db.prepare(`
      UPDATE scan_runs
         SET status = 'failed',
             error_message = 'Server restarted during tick',
             finished_at = CAST(strftime('%s','now') AS INTEGER) * 1000
       WHERE status = 'running'
    `).run();
  }

  /**
   * Delete old scan_runs rows. Per-stack retention:
   *   - keep at least `keepLast` most-recent rows per stack
   *   - pin rows with hits_dispatched > 0 (never reaped — they fired at
   *     least one investigation so they're audit-worthy regardless of age)
   *   - otherwise drop rows older than `maxAgeMs`
   * scan_run_investigations rows are deleted explicitly (FK cascade is declarative-only).
   */
  reapScanRuns(opts: { keepLast: number; maxAgeMs: number }): number {
    const cutoff = Date.now() - opts.maxAgeMs;
    // Select the ids to delete first (window function + age predicate + pin predicate).
    // `hits_dispatched > 0` pins the row regardless of age — operators need to
    // keep the audit trail of what fired, even long after the tick itself.
    const toDelete = this.db.prepare(`
      SELECT id FROM (
        SELECT
          id,
          hits_dispatched,
          started_at,
          ROW_NUMBER() OVER (PARTITION BY stack_id ORDER BY started_at DESC) AS rn
        FROM scan_runs
      )
      WHERE rn > ?
        AND started_at < ?
        AND (hits_dispatched IS NULL OR hits_dispatched = 0)
    `).all(opts.keepLast, cutoff) as Array<{ id: string }>;

    if (toDelete.length === 0) return 0;

    // Delete children first (FK cascade is declarative-only), then parents, in a transaction.
    const deleteChildren = this.db.prepare(`DELETE FROM scan_run_investigations WHERE scan_run_id = ?`);
    const deleteParent = this.db.prepare(`DELETE FROM scan_runs WHERE id = ?`);
    const txn = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteChildren.run(id);
        deleteParent.run(id);
      }
    });
    txn(toDelete.map(r => r.id));
    return toDelete.length;
  }

  /**
   * All investigations linked to a scan_run, ordered by dispatch time
   * ascending — useful for rendering a chronological timeline on the
   * ScanRunDetail page.
   */
  getScanRunInvestigations(scanRunId: string): ScanRunInvestigationRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM scan_run_investigations WHERE scan_run_id = ? ORDER BY dispatched_at ASC
    `).all(scanRunId) as Record<string, unknown>[];
    return rows.map(r => ({
      scanRunId: r["scan_run_id"] as string,
      investigationId: r["investigation_id"] as string,
      service: r["service"] as string,
      ruleName: r["rule_name"] as string,
      value: r["value"] as number,
      severity: r["severity"] as number,
      dispatchedAt: r["dispatched_at"] as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}

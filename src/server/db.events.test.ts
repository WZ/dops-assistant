import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";

const S = "stack-a";

let CLOCK = 0;
function nextTs(): number {
  CLOCK += 1000;
  return CLOCK;
}

interface SeedEvent {
  id?: string;
  ts?: number;
  kind?: string;
  severity?: string;
  summary?: string;
  stackId?: string | null;
  service?: string;
  href?: string;
  meta?: Record<string, string | number | boolean>;
}

let nextSeq = 0;
function seed(db: Database, e: SeedEvent = {}) {
  const id = e.id ?? `evt_${(nextSeq++).toString(36)}`;
  const stackId = e.stackId === null ? undefined : (e.stackId ?? S);
  db.insertEvent({
    id,
    ts: e.ts ?? nextTs(),
    kind: e.kind ?? "investigation_started",
    severity: e.severity ?? "info",
    summary: e.summary ?? "Test event",
    stackId,
    ...(e.service ? { service: e.service } : {}),
    ...(e.href ? { href: e.href } : {}),
    ...(e.meta ? { meta: e.meta } : {}),
  });
  return id;
}

describe("Database.listEvents + countEvents", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    CLOCK = Date.parse("2026-04-25T00:00:00Z");
    nextSeq = 0;
  });
  afterEach(() => db.close());

  it("returns rows newest-first by default", () => {
    seed(db, { kind: "investigation_started" });
    seed(db, { kind: "investigation_completed" });
    seed(db, { kind: "scan_run_complete" });
    const rows = db.listEvents({ stackId: S });
    expect(rows.map((r) => r.kind)).toEqual([
      "scan_run_complete",
      "investigation_completed",
      "investigation_started",
    ]);
    expect(db.countEvents({ stackId: S })).toBe(3);
  });

  it("scopes to the stack but includes global rows (NULL stack_id)", () => {
    seed(db, { stackId: S, kind: "investigation_started" });
    seed(db, { stackId: null, kind: "alert_received" }); // global event
    seed(db, { stackId: "other-stack", kind: "scan_run_complete" });
    const rows = db.listEvents({ stackId: S });
    expect(rows.map((r) => r.kind).sort()).toEqual(["alert_received", "investigation_started"]);
    expect(db.countEvents({ stackId: S })).toBe(2);
  });

  it("filters by kind (multi-select)", () => {
    seed(db, { kind: "investigation_started" });
    seed(db, { kind: "investigation_completed" });
    seed(db, { kind: "scan_run_complete" });
    const rows = db.listEvents({
      stackId: S,
      kind: ["investigation_started", "scan_run_complete"],
    });
    expect(rows.map((r) => r.kind).sort()).toEqual([
      "investigation_started",
      "scan_run_complete",
    ]);
  });

  it("filters by severity (multi-select)", () => {
    seed(db, { severity: "info" });
    seed(db, { severity: "warn" });
    seed(db, { severity: "error" });
    const rows = db.listEvents({ stackId: S, severity: ["warn", "error"] });
    expect(rows.map((r) => r.severity).sort()).toEqual(["error", "warn"]);
  });

  it("filters by service (single)", () => {
    seed(db, { service: "payments-api" });
    seed(db, { service: "checkout-api" });
    seed(db, { service: "payments-api" });
    seed(db, { /* no service */ });
    const rows = db.listEvents({ stackId: S, service: "payments-api" });
    expect(rows).toHaveLength(2);
  });

  it("filters by since/until window", () => {
    const t = Date.parse("2026-04-25T12:00:00Z");
    seed(db, { ts: t - 60_000, kind: "early" });
    seed(db, { ts: t,          kind: "in" });
    seed(db, { ts: t + 60_000, kind: "late" });
    const rows = db.listEvents({
      stackId: S,
      since: t - 30_000,
      until: t + 30_000,
    });
    expect(rows.map((r) => r.kind)).toEqual(["in"]);
  });

  it("q searches summary case-insensitively, with %% / _ escaped", () => {
    seed(db, { summary: "5xx error rate spiked" });
    seed(db, { summary: "OOMKilled in upstream worker" });
    seed(db, { summary: "100% queue full" });
    expect(db.listEvents({ stackId: S, q: "OOMKILLED" }).map((r) => r.summary))
      .toEqual(["OOMKilled in upstream worker"]);
    // Without escape, "100%" would match the OOMKilled row too. With escape,
    // only the literal-percent row.
    expect(db.listEvents({ stackId: S, q: "100%" }).map((r) => r.summary))
      .toEqual(["100% queue full"]);
  });

  it("paginates with limit + offset", () => {
    for (let i = 0; i < 7; i++) seed(db);
    const page1 = db.listEvents({ stackId: S, limit: 3, offset: 0 });
    const page2 = db.listEvents({ stackId: S, limit: 3, offset: 3 });
    const page3 = db.listEvents({ stackId: S, limit: 3, offset: 6 });
    expect(page1).toHaveLength(3);
    expect(page2).toHaveLength(3);
    expect(page3).toHaveLength(1);
    const all = [...page1, ...page2, ...page3].map((r) => r.id);
    expect(new Set(all).size).toBe(7);
  });

  it("listEventKinds returns distinct kinds alphabetically (incl. global)", () => {
    seed(db, { kind: "scan_run_complete" });
    seed(db, { kind: "investigation_started" });
    seed(db, { kind: "investigation_started" });
    seed(db, { kind: "alert_received", stackId: null });
    expect(db.listEventKinds(S)).toEqual([
      "alert_received",
      "investigation_started",
      "scan_run_complete",
    ]);
  });

  it("listEventServices returns distinct services with at least one event", () => {
    seed(db, { service: "payments-api" });
    seed(db, { service: "checkout-api" });
    seed(db, { service: "payments-api" });
    seed(db, { /* no service */ });
    expect(db.listEventServices(S)).toEqual(["checkout-api", "payments-api"]);
  });

  it("round-trips meta JSON", () => {
    seed(db, { meta: { duration_ms: 1234, retry_count: 0, success: true } });
    const [row] = db.listEvents({ stackId: S });
    expect(row?.meta).toEqual({ duration_ms: 1234, retry_count: 0, success: true });
  });

  it("round-trips href + service + stack_id", () => {
    seed(db, {
      service: "payments-api",
      href: "/investigations/inv_xyz",
      stackId: S,
    });
    const [row] = db.listEvents({ stackId: S });
    expect(row?.href).toBe("/investigations/inv_xyz");
    expect(row?.service).toBe("payments-api");
    expect(row?.stackId).toBe(S);
  });

  it("stackId=undefined disables scoping (admin / cross-stack queries)", () => {
    seed(db, { stackId: S });
    seed(db, { stackId: "other-stack" });
    seed(db, { stackId: null });
    expect(db.countEvents({})).toBe(3);
    expect(db.listEvents({})).toHaveLength(3);
  });

  it("INSERT OR IGNORE — duplicate id is a no-op", () => {
    db.insertEvent({ id: "evt_x", ts: 100, kind: "k", severity: "info", summary: "first", stackId: S });
    db.insertEvent({ id: "evt_x", ts: 200, kind: "k", severity: "info", summary: "second", stackId: S });
    const rows = db.listEvents({ stackId: S });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("first");
  });
});

describe("Database.purgeEventsOlderThan", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  it("deletes rows older than the cutoff and reports the count", () => {
    db.insertEvent({ id: "old1", ts: 1000, kind: "k", severity: "info", summary: "x", stackId: S });
    db.insertEvent({ id: "old2", ts: 2000, kind: "k", severity: "info", summary: "x", stackId: S });
    db.insertEvent({ id: "new",  ts: 5000, kind: "k", severity: "info", summary: "x", stackId: S });
    const removed = db.purgeEventsOlderThan(3000);
    expect(removed).toBe(2);
    expect(db.countEvents({ stackId: S })).toBe(1);
  });

  it("returns 0 when no rows match", () => {
    db.insertEvent({ id: "fresh", ts: Date.now(), kind: "k", severity: "info", summary: "x", stackId: S });
    expect(db.purgeEventsOlderThan(0)).toBe(0);
  });
});

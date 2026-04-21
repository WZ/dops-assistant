// src/server/event-log.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { EventLog } from "./event-log.js";

describe("EventLog", () => {
  let log: EventLog;
  beforeEach(() => { log = new EventLog({ capacity: 3 }); });

  it("returns empty on fresh log", () => {
    expect(log.recent()).toEqual({ events: [], truncated: false });
  });

  it("returns events newest first", () => {
    log.append({ kind: "alert_received", severity: "warn", summary: "a" });
    log.append({ kind: "alert_received", severity: "warn", summary: "b" });
    const out = log.recent();
    expect(out.events.map(e => e.summary)).toEqual(["b", "a"]);
  });

  it("drops oldest past capacity and reports truncated", () => {
    log.append({ kind: "alert_received", severity: "warn", summary: "a" });
    log.append({ kind: "alert_received", severity: "warn", summary: "b" });
    log.append({ kind: "alert_received", severity: "warn", summary: "c" });
    log.append({ kind: "alert_received", severity: "warn", summary: "d" });
    const out = log.recent();
    expect(out.events.map(e => e.summary)).toEqual(["d", "c", "b"]);
    expect(out.truncated).toBe(true);
  });

  it("caps summary at 80 chars", () => {
    const long = "x".repeat(200);
    log.append({ kind: "alert_received", severity: "warn", summary: long });
    expect(log.recent().events[0].summary.length).toBe(80);
  });

  it("filters by stackId but includes stack-less (global) events", () => {
    log.append({ kind: "investigation_started", severity: "info", summary: "a", stackId: "stack-a" });
    log.append({ kind: "investigation_started", severity: "info", summary: "b", stackId: "stack-b" });
    log.append({ kind: "provider_health_changed", severity: "error", summary: "global" });
    const scoped = log.recent(10, "stack-a");
    expect(scoped.events.map((e) => e.summary)).toEqual(["global", "a"]);
    const all = log.recent(10);
    expect(all.events.map((e) => e.summary)).toEqual(["global", "b", "a"]);
  });
});

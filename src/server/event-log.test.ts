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
});

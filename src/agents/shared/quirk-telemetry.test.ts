import { describe, it, expect, beforeEach } from "vitest";
import { quirkHit, getQuirkHits, resetQuirkHits } from "./quirk-telemetry.js";

describe("quirkHit", () => {
  beforeEach(() => resetQuirkHits());

  it("counts hits per key", () => {
    quirkHit("test:a");
    quirkHit("test:a");
    quirkHit("test:b");
    const hits = getQuirkHits();
    expect(hits["test:a"]?.count).toBe(2);
    expect(hits["test:b"]?.count).toBe(1);
  });

  it("records last meta", () => {
    quirkHit("test:a", { attempt: 1 });
    quirkHit("test:a", { attempt: 2 });
    expect(getQuirkHits()["test:a"]?.lastMeta).toEqual({ attempt: 2 });
  });

  it("tracks first/last seen timestamps", () => {
    const before = Date.now();
    quirkHit("test:a");
    const after = Date.now();
    const rec = getQuirkHits()["test:a"]!;
    expect(rec.firstSeenMs).toBeGreaterThanOrEqual(before);
    expect(rec.firstSeenMs).toBeLessThanOrEqual(after);
    expect(rec.lastSeenMs).toBeGreaterThanOrEqual(rec.firstSeenMs);
  });

  it("returns empty object when no hits", () => {
    expect(getQuirkHits()).toEqual({});
  });

  it("never throws on weird meta", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => quirkHit("test:circular", circular)).not.toThrow();
    expect(getQuirkHits()["test:circular"]?.count).toBe(1);
  });

  it("resetQuirkHits clears all state", () => {
    quirkHit("test:a", { foo: 1 });
    resetQuirkHits();
    expect(getQuirkHits()).toEqual({});
  });
});

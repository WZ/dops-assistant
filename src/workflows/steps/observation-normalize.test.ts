import { describe, it, expect } from "vitest";
import { normalizeObservations } from "./observation-normalize.js";

describe("normalizeObservations", () => {
  it("normalizes the four phase shapes into flat observations", () => {
    const out = normalizeObservations({
      metrics: { observations: [{ metric: "payments p99", currentValue: "8.0s", baselineValue: "0.2s", severity: "critical" }] },
      logs: { observations: [{ pattern: "connection pool exhausted", sample: "FATAL: pool exhausted", firstSeen: "2026-04-02T13:59:00Z" }] },
      infra: { observations: [{ resource: "checkout-api", status: "OOMKilled", detail: "restarted 3x", timestamp: "2026-04-02T14:04:00Z" }] },
      changes: { observations: [{ type: "deploy", title: "v2.3.1", author: "ci", timestamp: "2026-04-02T13:58:00Z" }] },
    });
    expect(out).toHaveLength(4);
    const metric = out.find((o) => o.phase === "metrics");
    expect(metric).toMatchObject({ subject: "payments p99", value: 8 });
    expect(out.find((o) => o.phase === "logs")?.text).toContain("pool exhausted");
    expect(out.find((o) => o.phase === "infra")?.text).toContain("OOMKilled");
    expect(out.find((o) => o.phase === "changes")?.timestamp).toBe("2026-04-02T13:58:00Z");
  });

  it("handles string observations and skips malformed entries", () => {
    const out = normalizeObservations({
      metrics: { observations: ["cpu high", 42, null, { noSubject: true }] },
      logs: { observations: ["timeout to db"] },
    });
    // "cpu high" (string) + "timeout to db" (string). 42/null/no-subject dropped.
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ phase: "metrics", subject: "cpu high" });
    expect(out[1]).toMatchObject({ phase: "logs", subject: "timeout to db" });
  });

  it("tolerates missing phases and empty observation arrays", () => {
    expect(normalizeObservations({})).toEqual([]);
    expect(normalizeObservations({ metrics: {} })).toEqual([]);
    expect(normalizeObservations({ infra: { observations: [] } })).toEqual([]);
  });

  it("falls back across field name variants (current/value, time)", () => {
    const out = normalizeObservations({
      metrics: { observations: [{ name: "error rate", value: "5%" }] },
      infra: { observations: [{ name: "node-1", status: "NotReady", time: "2026-04-02T14:00:00Z" }] },
    });
    expect(out.find((o) => o.phase === "metrics")).toMatchObject({ subject: "error rate", value: 5 });
    expect(out.find((o) => o.phase === "infra")).toMatchObject({ subject: "node-1", timestamp: "2026-04-02T14:00:00Z" });
  });
});

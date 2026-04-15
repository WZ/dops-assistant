import { describe, it, expect } from "vitest";
import { coerceLokiArgs, coerceToolArgs } from "./tool-utils.js";

// Schema with a couple of time fields so coerceToolArgs' time-field branch fires.
const timeSchema = {
  properties: {
    startTime: { type: "string" },
    endTime: { type: "string" },
    startRfc3339: { type: "string" },
    name: { type: "string" },
  },
};

describe("coerceToolArgs — malformed .Z RFC3339 suffix", () => {
  // Fix #5 (plan-eng-review 2026-04-15): LLMs consistently truncate
  // "2026-04-15T20:27:00.000Z" to "2026-04-15T20:27:00.Z", which is not
  // valid RFC3339. The Grafana MCP tool rejects it. Normalize the trailing
  // ".Z" to "Z" on time fields so the LLM doesn't waste a round-trip.

  it('normalizes "2026-04-15T20:27:00.Z" → "2026-04-15T20:27:00Z"', () => {
    const out = coerceToolArgs({ startTime: "2026-04-15T20:27:00.Z" }, timeSchema);
    expect(out.startTime).toBe("2026-04-15T20:27:00Z");
  });

  it("also normalizes on the alternate rfc3339 field name", () => {
    const out = coerceToolArgs({ startRfc3339: "2026-04-15T20:27:00.Z" }, timeSchema);
    expect(out.startRfc3339).toBe("2026-04-15T20:27:00Z");
  });

  it('leaves "2026-04-15T20:27:00Z" unchanged (already valid, idempotent)', () => {
    const out = coerceToolArgs({ startTime: "2026-04-15T20:27:00Z" }, timeSchema);
    expect(out.startTime).toBe("2026-04-15T20:27:00Z");
  });

  it('leaves "2026-04-15T20:27:00.000Z" unchanged (fractional seconds are valid)', () => {
    const out = coerceToolArgs({ startTime: "2026-04-15T20:27:00.000Z" }, timeSchema);
    expect(out.startTime).toBe("2026-04-15T20:27:00.000Z");
  });

  it('does not touch non-time fields even if their value ends in ".Z"', () => {
    const out = coerceToolArgs({ name: "prefix.Z" }, timeSchema);
    expect(out.name).toBe("prefix.Z");
  });
});

describe("coerceLokiArgs — strip stepSeconds", () => {
  // Fix #6 (plan-eng-review 2026-04-15): stepSeconds is a Prometheus concept.
  // grafana_query_loki_logs doesn't accept it, but the LLM consistently passes
  // it. Drop it before the tool sees it.

  it("deletes stepSeconds when present", () => {
    const out = coerceLokiArgs({
      stepSeconds: 300,
      direction: "forward",
      limit: 20,
      logql: '{app="foo"}',
    });
    expect(out).not.toHaveProperty("stepSeconds");
    expect(out.direction).toBe("backward"); // existing coercion still runs
    expect(out.limit).toBe(50);              // existing coercion still runs
    expect(out.logql).toBe('{app="foo"}');   // unrelated fields untouched
  });

  it("is a no-op for stepSeconds when already absent", () => {
    const out = coerceLokiArgs({ direction: "backward", limit: 100 });
    expect(out).not.toHaveProperty("stepSeconds");
    expect(out.direction).toBe("backward");
    expect(out.limit).toBe(100);
  });
});

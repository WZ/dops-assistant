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

  it('leaves "2026-04-15T20:27:00.0Z" unchanged (valid zero-fraction)', () => {
    const out = coerceToolArgs({ startTime: "2026-04-15T20:27:00.0Z" }, timeSchema);
    expect(out.startTime).toBe("2026-04-15T20:27:00.0Z");
  });

  it('normalizes "2026-04-15T20:27:00." (dangling dot, no Z)', () => {
    const out = coerceToolArgs({ startTime: "2026-04-15T20:27:00." }, timeSchema);
    expect(out.startTime).toBe("2026-04-15T20:27:00Z");
  });

  it('adds Z to a bare "2026-04-15T20:27:00" (missing Z entirely)', () => {
    const out = coerceToolArgs({ startTime: "2026-04-15T20:27:00" }, timeSchema);
    expect(out.startTime).toBe("2026-04-15T20:27:00Z");
  });

  it('does not touch non-time fields even if their value ends in ".Z"', () => {
    const out = coerceToolArgs({ name: "prefix.Z" }, timeSchema);
    expect(out.name).toBe("prefix.Z");
  });
});

describe("coerceLokiArgs — direction/limit", () => {
  // stepSeconds-dropped coercion was removed in 2026-05 — 51 stress iters
  // showed 0 fires; the model doesn't send stepSeconds on Loki tools anymore.
  // The direction-forced + limit-bumped coercions stay (pre-assigned KEEP).

  it("forces direction=backward and limit=50 when LLM under-specifies", () => {
    const out = coerceLokiArgs({
      direction: "forward",
      limit: 20,
      logql: '{app="foo"}',
    });
    expect(out.direction).toBe("backward");
    expect(out.limit).toBe(50);
    expect(out.logql).toBe('{app="foo"}');
  });

  it("preserves direction/limit when already at safe values", () => {
    const out = coerceLokiArgs({ direction: "backward", limit: 100 });
    expect(out.direction).toBe("backward");
    expect(out.limit).toBe(100);
  });
});

describe("coerceLokiArgs — invalid OR-chain LogQL repair", () => {
  // gpt-oss emits `{sel} |= "a" or {sel} |= "b" or {sel} |= "c"` to search multiple
  // terms, which is invalid LogQL → Loki HTTP 400 → zero log evidence gathered.
  // Collapse it into a single regex line filter.
  it("collapses a repeated-selector OR-chain into one regex line filter", () => {
    const out = coerceLokiArgs({
      direction: "backward",
      limit: 50,
      logql: '{container_name="svc"} |= "replicas" or {container_name="svc"} |= "scale" or {container_name="svc"} |= "deployment"',
    });
    expect(out.logql).toBe('{container_name="svc"} |~ "replicas|scale|deployment"');
  });

  it("dedupes repeated terms and preserves a single valid line filter untouched", () => {
    expect(coerceLokiArgs({ logql: '{app="x"} |= "err" or {app="x"} |= "err"' }).logql).toBe('{app="x"} |~ "err"');
    expect(coerceLokiArgs({ logql: '{app="x"} |= "error"' }).logql).toBe('{app="x"} |= "error"'); // single filter: no rewrite
    expect(coerceLokiArgs({ logql: '{app="x"} |~ "a|b"' }).logql).toBe('{app="x"} |~ "a|b"'); // already regex: untouched
  });
});

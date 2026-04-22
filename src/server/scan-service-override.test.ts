import { describe, it, expect } from "vitest";
import { validateOverride, parseOverride } from "./scan-service-override.js";

describe("validateOverride", () => {
  it("rejects empty body — must specify disabled or rules", () => {
    const r = validateOverride({});
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("disabled");
  });

  it("accepts {disabled:true}", () => {
    const r = validateOverride({ disabled: true });
    expect(r.ok).toBe(true);
    expect(r.override).toEqual({ disabled: true });
  });

  it("accepts {disabled:false} — a no-op override still explicit", () => {
    // Edge: operator toggles disabled off without switching mode; we accept
    // the payload but it's effectively "no override except a flag saying so".
    // Caller (UI) should use DELETE for "revert to global" instead.
    const r = validateOverride({ disabled: false });
    expect(r.ok).toBe(true);
    expect(r.override).toEqual({ disabled: false });
  });

  it("validates rules via validateRules (name uniqueness, {service} check)", () => {
    const r = validateOverride({
      rules: [
        { name: "x", query: "up", threshold: { op: "lt", value: 1 } }, // missing {service}
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.message.includes("{service}"))).toBe(true);
  });

  it("accepts a valid rules array and defaults consecutiveTicks", () => {
    const r = validateOverride({
      rules: [
        { name: "availability", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.override!.rules![0]!.consecutiveTicks).toBe(1);
  });

  it("rejects unknown top-level fields (strict mode)", () => {
    const r = validateOverride({ disabled: true, surprise: "hi" });
    expect(r.ok).toBe(false);
  });

  it("rejects non-array rules", () => {
    const r = validateOverride({ rules: "not an array" });
    expect(r.ok).toBe(false);
  });
});

describe("parseOverride", () => {
  it("returns null for null or empty input", () => {
    expect(parseOverride(null)).toBeNull();
    expect(parseOverride("")).toBeNull();
  });

  it("parses a valid JSON envelope", () => {
    expect(parseOverride('{"disabled":true}')).toEqual({ disabled: true });
    expect(parseOverride('{"rules":[]}')).toEqual({ rules: [] });
  });

  it("returns null on invalid JSON (soft fallback — don't crash the scheduler)", () => {
    expect(parseOverride("{ not json")).toBeNull();
  });

  it("returns null when parsed value isn't an object", () => {
    expect(parseOverride('"string"')).toBeNull();
    expect(parseOverride("42")).toBeNull();
    expect(parseOverride("null")).toBeNull();
  });
});

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

  it("rejects {disabled:false} alone — it's a no-op, operator should DELETE instead", () => {
    // `{ disabled: false }` with no rules means "scan this service using
    // global rules" — which is exactly what happens when no override exists.
    // Accepting it clutters the DB and the UI. Force explicit DELETE.
    const r = validateOverride({ disabled: false });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === "disabled" && e.message.includes("no-op"))).toBe(true);
  });

  it("accepts {disabled:false, rules:[...]} — explicit override with rules", () => {
    // The rules payload justifies the override existing; disabled:false is
    // just saying "don't skip this service". Different from `{disabled:false}`
    // alone because rules override the globals.
    const r = validateOverride({
      disabled: false,
      rules: [{ name: "x", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.override).toEqual({
      disabled: false,
      rules: [{ name: "x", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1, source: "metrics" }],
    });
  });

  it("rejects {rules: []} alone — ambiguous (disable? or use globals?)", () => {
    // Before this fix, the probe silently fell back to globals when override
    // rules were empty. That meant operators who typed `rules: []` got
    // *more* rules, not fewer. Reject at validation and force intent.
    const r = validateOverride({ rules: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === "rules" && e.message.includes("ambiguous"))).toBe(true);
  });

  it("accepts {disabled:true, rules:[]} — service skipped regardless of rules", () => {
    // Edge: operator might want to disable AND declare zero rules for clarity.
    // Probe skips the service on `disabled:true` so the rules never fire,
    // but the payload is internally consistent.
    const r = validateOverride({ disabled: true, rules: [] });
    expect(r.ok).toBe(true);
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

  it("parses a valid JSON envelope with disabled flag", () => {
    expect(parseOverride('{"disabled":true}')).toEqual({ disabled: true });
  });

  it("parses a valid JSON envelope with rules (defaults applied)", () => {
    const raw = JSON.stringify({
      rules: [{ name: "x", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 } }],
    });
    expect(parseOverride(raw)).toEqual({
      rules: [{ name: "x", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 }, consecutiveTicks: 1, source: "metrics" }],
    });
  });

  it("returns null on invalid JSON (soft fallback — don't crash the scheduler)", () => {
    expect(parseOverride("{ not json")).toBeNull();
  });

  it("returns null when parsed value isn't an object envelope (number / string / null)", () => {
    expect(parseOverride('"string"')).toBeNull();
    expect(parseOverride("42")).toBeNull();
    expect(parseOverride("null")).toBeNull();
  });

  it("returns null when envelope has unknown fields (strict read)", () => {
    // Manual sqlite write from an older schema might include unknown keys.
    // Safer to treat as corrupted and fall back to global than to pass
    // through a half-understood payload.
    expect(parseOverride('{"disabled":true,"surprise":"hi"}')).toBeNull();
  });

  it("returns null when stored rules have malformed shape (re-validated on read)", () => {
    // Before the fix, parseOverride cast blindly to ScanServiceOverride and
    // anomaly-probe would crash reading rule.name / rule.query. Now it runs
    // rules through validateRules and falls back cleanly.
    const raw = JSON.stringify({ rules: [{ nope: "garbage" }, 42, null] });
    expect(parseOverride(raw)).toBeNull();
  });

  it("returns null when stored rule name contains ':' (write-validator reservation honored on read)", () => {
    const raw = JSON.stringify({
      rules: [{ name: "db:slow", query: 'up{service="{service}"}', threshold: { op: "lt", value: 1 } }],
    });
    expect(parseOverride(raw)).toBeNull();
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { formatTimestamp } from "./formatTimestamp";

// Frozen clock: 2026-04-17T12:00:00Z
const NOW = Date.UTC(2026, 3, 17, 12, 0, 0);

describe("formatTimestamp", () => {
  describe("relative", () => {
    it("returns 'never' for null/undefined/empty", () => {
      expect(formatTimestamp(null, "relative")).toBe("never");
      expect(formatTimestamp(undefined, "relative")).toBe("never");
      expect(formatTimestamp("", "relative")).toBe("never");
    });

    it("returns 'never' for unparseable strings", () => {
      expect(formatTimestamp("not-a-date", "relative")).toBe("never");
    });

    it("returns 'just now' for deltas under a minute", () => {
      expect(formatTimestamp(new Date(NOW - 5_000).toISOString(), "relative", { now: NOW })).toBe("just now");
      expect(formatTimestamp(new Date(NOW - 30_000).toISOString(), "relative", { now: NOW })).toBe("just now");
      expect(formatTimestamp(new Date(NOW - 59_000).toISOString(), "relative", { now: NOW })).toBe("just now");
    });

    it("returns 'Nm ago' under an hour", () => {
      const iso = new Date(NOW - 2 * 60_000).toISOString();
      expect(formatTimestamp(iso, "relative", { now: NOW })).toBe("2m ago");
    });

    it("returns 'Nh ago' under a day", () => {
      const iso = new Date(NOW - 3 * 3_600_000).toISOString();
      expect(formatTimestamp(iso, "relative", { now: NOW })).toBe("3h ago");
    });

    it("returns 'Nd ago' for days", () => {
      const iso = new Date(NOW - 5 * 86_400_000).toISOString();
      expect(formatTimestamp(iso, "relative", { now: NOW })).toBe("5d ago");
    });

    it("clamps future timestamps to 'just now'", () => {
      const iso = new Date(NOW + 60_000).toISOString();
      expect(formatTimestamp(iso, "relative", { now: NOW })).toBe("just now");
    });
  });

  describe("local", () => {
    it("returns empty string for missing input", () => {
      expect(formatTimestamp(null, "local")).toBe("");
      expect(formatTimestamp("", "local")).toBe("");
    });

    it("formats as 'Mon DD, H:MM AM/PM' in the user locale", () => {
      const iso = "2026-04-17T18:33:00Z";
      const result = formatTimestamp(iso, "local");
      // The exact string depends on the test env's locale/tz, so assert shape:
      // - contains the month abbreviation (Apr)
      // - contains a comma + space separator
      // - contains the minutes (33)
      expect(result).toContain("Apr");
      expect(result).toMatch(/, /);
      expect(result).toContain("33");
    });
  });

  describe("utc", () => {
    it("returns empty string for missing input", () => {
      expect(formatTimestamp(null, "utc")).toBe("");
      expect(formatTimestamp("", "utc")).toBe("");
    });

    it("returns seconds-precision ISO 8601", () => {
      expect(formatTimestamp("2026-04-17T00:00:00.000Z", "utc")).toBe("2026-04-17T00:00:00Z");
    });

    it("normalizes non-UTC input to UTC", () => {
      // 2026-04-17T12:00:00+02:00 → 2026-04-17T10:00:00Z
      expect(formatTimestamp("2026-04-17T12:00:00+02:00", "utc")).toBe("2026-04-17T10:00:00Z");
    });
  });
});

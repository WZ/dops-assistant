import { describe, it, expect } from "vitest";
import { normalizeTimestamp, normalizeRow } from "./db.js";

describe("normalizeTimestamp", () => {
  it("converts SQLite datetime (no T, no Z) to ISO 8601", () => {
    const result = normalizeTimestamp("2026-03-15 14:30:00");
    expect(result).toBe("2026-03-15T14:30:00.000Z");
  });

  it("handles midnight correctly", () => {
    const result = normalizeTimestamp("2026-01-01 00:00:00");
    expect(result).toBe("2026-01-01T00:00:00.000Z");
  });

  it("treats the input as UTC (appends Z before parsing)", () => {
    const result = normalizeTimestamp("2026-06-15 23:59:59");
    expect(result).toBe("2026-06-15T23:59:59.000Z");
  });

  it("returns a string ending in Z", () => {
    const result = normalizeTimestamp("2026-04-01 12:00:00");
    expect(result.endsWith("Z")).toBe(true);
  });

  it("returns a string containing T separator", () => {
    const result = normalizeTimestamp("2026-04-01 12:00:00");
    expect(result.includes("T")).toBe(true);
  });
});

describe("normalizeRow", () => {
  it("converts _at fields from SQLite format to ISO 8601", () => {
    const row = { id: "abc", created_at: "2026-03-15 14:30:00", status: "complete" };
    const result = normalizeRow(row);
    expect(result.created_at).toBe("2026-03-15T14:30:00.000Z");
    expect(result.id).toBe("abc");
    expect(result.status).toBe("complete");
  });

  it("leaves _at fields that are already ISO 8601 unchanged", () => {
    const ts = "2026-03-15T14:30:00.000Z";
    const row = { created_at: ts };
    const result = normalizeRow(row);
    expect(result.created_at).toBe(ts);
  });

  it("handles null _at fields", () => {
    const row = { created_at: "2026-03-15 14:30:00", completed_at: null };
    const result = normalizeRow(row);
    expect(result.created_at).toBe("2026-03-15T14:30:00.000Z");
    expect(result.completed_at).toBeNull();
  });

  it("does not modify non-_at string fields", () => {
    const row = { status: "running", query: "check service", created_at: "2026-03-15 14:30:00" };
    const result = normalizeRow(row);
    expect(result.status).toBe("running");
    expect(result.query).toBe("check service");
  });

  it("handles arrays of rows", () => {
    const rows = [
      { id: "1", created_at: "2026-01-01 00:00:00" },
      { id: "2", created_at: "2026-06-01 12:00:00" },
    ];
    const result = normalizeRow(rows);
    expect(result[0].created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(result[1].created_at).toBe("2026-06-01T12:00:00.000Z");
  });

  it("returns null and undefined unchanged", () => {
    expect(normalizeRow(null)).toBeNull();
    expect(normalizeRow(undefined)).toBeUndefined();
  });

  it("converts both created_at and completed_at when both are present", () => {
    const row = {
      id: "inv-1",
      created_at: "2026-03-15 10:00:00",
      completed_at: "2026-03-15 10:05:00",
      status: "complete",
    };
    const result = normalizeRow(row);
    expect(result.created_at).toBe("2026-03-15T10:00:00.000Z");
    expect(result.completed_at).toBe("2026-03-15T10:05:00.000Z");
  });

  it("converts started_at and updated_at fields", () => {
    const row = { started_at: "2026-03-15 08:00:00", updated_at: "2026-03-15 09:00:00" };
    const result = normalizeRow(row);
    expect(result.started_at).toBe("2026-03-15T08:00:00.000Z");
    expect(result.updated_at).toBe("2026-03-15T09:00:00.000Z");
  });

  it("ignores empty string _at fields", () => {
    const row = { created_at: "" };
    // Should not throw; empty string + 'Z' parses as NaN date, toISOString returns "Invalid Date"
    // The guard `v.length > 0` prevents this from being passed to normalizeTimestamp
    const result = normalizeRow(row);
    expect(result.created_at).toBe("");
  });
});

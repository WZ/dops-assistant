import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { saveIncident, getRecentIncidents, formatIncidentHistory, toFilename, type IncidentRecord } from "./store.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(import.meta.dirname!, "tmp-test-"));
}

function makeRecord(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    service: "payments-api",
    severity: "high",
    summary: "High error rate caused by DB connection pool exhaustion",
    rootCause: "DB connection pool exhausted",
    trigger: "Traffic spike saturated connection pool",
    investigatedAt: "2026-03-09T14:30:00Z",
    confidence: "high",
    ...overrides,
  };
}

describe("saveIncident", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a JSON file under .dops/incidents/{service}/", () => {
    const record = makeRecord();
    saveIncident(record, tmpDir);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);

    const content = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf-8"));
    expect(content.service).toBe("payments-api");
    expect(content.rootCause).toBe("DB connection pool exhausted");
  });

  it("uses ISO timestamp with colons replaced by dashes for filename", () => {
    const record = makeRecord({ investigatedAt: "2026-03-09T14:30:00Z" });
    saveIncident(record, tmpDir);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    const files = fs.readdirSync(dir);
    expect(files[0]).toBe("2026-03-09T14-30-00Z.json");
  });

  it("skips saving low-severity incidents", () => {
    const record = makeRecord({ severity: "low" });
    saveIncident(record, tmpDir);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("creates directories if they do not exist", () => {
    const record = makeRecord({ service: "new-service" });
    saveIncident(record, tmpDir);

    const dir = path.join(tmpDir, ".dops", "incidents", "new-service");
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });
});

describe("getRecentIncidents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeIncident(record: IncidentRecord): void {
    const dir = path.join(tmpDir, ".dops", "incidents", record.service);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, toFilename(record.investigatedAt)),
      JSON.stringify(record, null, 2),
    );
  }

  it("returns incidents sorted newest-first", () => {
    const older = makeRecord({ investigatedAt: "2026-03-07T10:00:00Z" });
    const newer = makeRecord({ investigatedAt: "2026-03-09T10:00:00Z" });
    writeIncident(older);
    writeIncident(newer);

    const results = getRecentIncidents("payments-api", tmpDir);
    expect(results).toHaveLength(2);
    expect(results[0]!.investigatedAt).toBe("2026-03-09T10:00:00Z");
    expect(results[1]!.investigatedAt).toBe("2026-03-07T10:00:00Z");
  });

  it("returns at most 5 incidents", () => {
    for (let i = 0; i < 7; i++) {
      writeIncident(makeRecord({ investigatedAt: `2026-03-0${i + 1}T10:00:00Z` }));
    }

    const results = getRecentIncidents("payments-api", tmpDir);
    expect(results).toHaveLength(5);
    // newest first
    expect(results[0]!.investigatedAt).toBe("2026-03-07T10:00:00Z");
  });

  it("returns empty array when directory does not exist", () => {
    const results = getRecentIncidents("nonexistent-service", tmpDir);
    expect(results).toEqual([]);
  });

  it("filters out incidents older than 30 days", () => {
    const recent = makeRecord({ investigatedAt: new Date().toISOString() });
    const old = makeRecord({ investigatedAt: "2025-01-01T10:00:00Z" });
    writeIncident(recent);
    writeIncident(old);

    const results = getRecentIncidents("payments-api", tmpDir);
    expect(results).toHaveLength(1);
    expect(new Date(results[0]!.investigatedAt).getTime()).toBeGreaterThan(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    );
  });

  it("skips corrupted JSON files gracefully", () => {
    const record = makeRecord({ investigatedAt: "2026-03-09T10:00:00Z" });
    writeIncident(record);

    // Write a corrupted file
    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    fs.writeFileSync(path.join(dir, "corrupted.json"), "not valid json{{{");

    const results = getRecentIncidents("payments-api", tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.investigatedAt).toBe("2026-03-09T10:00:00Z");
  });
});

describe("pruning on write", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeIncident(record: IncidentRecord): void {
    const dir = path.join(tmpDir, ".dops", "incidents", record.service);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, toFilename(record.investigatedAt)),
      JSON.stringify(record, null, 2),
    );
  }

  it("deletes files older than 30 days when saving", () => {
    // Pre-seed an old incident (60 days ago)
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    writeIncident(makeRecord({ investigatedAt: oldDate }));

    // Save a new incident — should trigger prune
    const newRecord = makeRecord({ investigatedAt: new Date().toISOString() });
    saveIncident(newRecord, tmpDir);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    const files = fs.readdirSync(dir);
    // Only the new file should remain (old one pruned)
    expect(files).toHaveLength(1);
    const content = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf-8"));
    expect(new Date(content.investigatedAt).getTime()).toBeGreaterThan(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    );
  });

  it("keeps at most 10 files after saving", () => {
    // Pre-seed 12 recent incidents (all within last 30 days)
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString();
      writeIncident(makeRecord({ investigatedAt: d }));
    }

    // Save a 13th incident — should trigger prune down to 10
    const newRecord = makeRecord({ investigatedAt: new Date().toISOString() });
    saveIncident(newRecord, tmpDir);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    const files = fs.readdirSync(dir);
    expect(files.length).toBeLessThanOrEqual(10);
  });
});

describe("formatIncidentHistory", () => {
  it("formats records as prompt-ready text with relative dates", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const records: IncidentRecord[] = [
      makeRecord({
        investigatedAt: twoDaysAgo,
        severity: "high",
        summary: "DB pool exhaustion",
        rootCause: "Connection leak",
      }),
      makeRecord({
        investigatedAt: fiveDaysAgo,
        severity: "critical",
        summary: "Full outage",
        rootCause: "Disk full",
      }),
    ];

    const result = formatIncidentHistory(records);

    expect(result).toContain("2 days ago");
    expect(result).toContain("[high]");
    expect(result).toContain("DB pool exhaustion");
    expect(result).toContain("(root cause: Connection leak)");
    expect(result).toContain("5 days ago");
    expect(result).toContain("[critical]");
    expect(result).toContain("Full outage");
    expect(result).toContain("(root cause: Disk full)");
  });

  it("returns empty string when no records", () => {
    expect(formatIncidentHistory([])).toBe("");
  });

  it("shows 'today' for incidents less than 1 day old", () => {
    const now = new Date().toISOString();
    const records: IncidentRecord[] = [
      makeRecord({ investigatedAt: now, summary: "Recent issue", rootCause: "Bug" }),
    ];

    const result = formatIncidentHistory(records);
    expect(result).toContain("today");
  });

  it("shows '1 day ago' for incidents exactly 1 day old", () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const records: IncidentRecord[] = [
      makeRecord({ investigatedAt: oneDayAgo, summary: "Yesterday issue", rootCause: "Config" }),
    ];

    const result = formatIncidentHistory(records);
    expect(result).toContain("1 day ago");
  });
});

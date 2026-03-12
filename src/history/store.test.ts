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

  it("writes a JSON file under .dops/incidents/{service}/", async () => {
    const record = makeRecord();
    await saveIncident(tmpDir, record);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);

    const content = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf-8"));
    expect(content.service).toBe("payments-api");
    expect(content.rootCause).toBe("DB connection pool exhausted");
  });

  it("uses ISO timestamp with colons replaced by dashes for filename", async () => {
    const record = makeRecord({ investigatedAt: "2026-03-09T14:30:00Z" });
    await saveIncident(tmpDir, record);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    const files = fs.readdirSync(dir);
    expect(files[0]).toBe("2026-03-09T14-30-00Z.json");
  });

  it("strips sub-second precision from filename", async () => {
    const record = makeRecord({ investigatedAt: "2026-03-09T14:30:00.123Z" });
    await saveIncident(tmpDir, record);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    const files = fs.readdirSync(dir);
    expect(files[0]).toBe("2026-03-09T14-30-00Z.json");
  });

  it("skips saving low-severity incidents", async () => {
    const record = makeRecord({ severity: "low" });
    await saveIncident(tmpDir, record);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("creates directories if they do not exist", async () => {
    const record = makeRecord({ service: "new-service" });
    await saveIncident(tmpDir, record);

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

  it("returns incidents sorted newest-first", async () => {
    const older = makeRecord({ investigatedAt: "2026-03-07T10:00:00Z" });
    const newer = makeRecord({ investigatedAt: "2026-03-09T10:00:00Z" });
    writeIncident(older);
    writeIncident(newer);

    const results = await getRecentIncidents(tmpDir, "payments-api");
    expect(results).toHaveLength(2);
    expect(results[0]!.investigatedAt).toBe("2026-03-09T10:00:00Z");
    expect(results[1]!.investigatedAt).toBe("2026-03-07T10:00:00Z");
  });

  it("returns at most 5 incidents", async () => {
    for (let i = 0; i < 7; i++) {
      writeIncident(makeRecord({ investigatedAt: `2026-03-0${i + 1}T10:00:00Z` }));
    }

    const results = await getRecentIncidents(tmpDir, "payments-api");
    expect(results).toHaveLength(5);
    // newest first
    expect(results[0]!.investigatedAt).toBe("2026-03-07T10:00:00Z");
  });

  it("returns empty array when directory does not exist", async () => {
    const results = await getRecentIncidents(tmpDir, "nonexistent-service");
    expect(results).toEqual([]);
  });

  it("filters out incidents older than 30 days", async () => {
    const recent = makeRecord({ investigatedAt: new Date().toISOString() });
    const old = makeRecord({ investigatedAt: "2025-01-01T10:00:00Z" });
    writeIncident(recent);
    writeIncident(old);

    const results = await getRecentIncidents(tmpDir, "payments-api");
    expect(results).toHaveLength(1);
    expect(new Date(results[0]!.investigatedAt).getTime()).toBeGreaterThan(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    );
  });

  it("skips corrupted JSON files gracefully", async () => {
    const record = makeRecord({ investigatedAt: "2026-03-09T10:00:00Z" });
    writeIncident(record);

    // Write a corrupted file
    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    fs.writeFileSync(path.join(dir, "corrupted.json"), "not valid json{{{");

    const results = await getRecentIncidents(tmpDir, "payments-api");
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

  it("deletes files older than 30 days when saving", async () => {
    // Pre-seed an old incident (60 days ago)
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    writeIncident(makeRecord({ investigatedAt: oldDate }));

    // Save a new incident — should trigger prune
    const newRecord = makeRecord({ investigatedAt: new Date().toISOString() });
    await saveIncident(tmpDir, newRecord);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    const files = fs.readdirSync(dir);
    // Only the new file should remain (old one pruned)
    expect(files).toHaveLength(1);
    const content = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf-8"));
    expect(new Date(content.investigatedAt).getTime()).toBeGreaterThan(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    );
  });

  it("keeps at most 10 files after saving", async () => {
    // Pre-seed 12 recent incidents (all within last 30 days)
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString();
      writeIncident(makeRecord({ investigatedAt: d }));
    }

    // Save a 13th incident — should trigger prune down to 10
    const newRecord = makeRecord({ investigatedAt: new Date().toISOString() });
    await saveIncident(tmpDir, newRecord);

    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    const files = fs.readdirSync(dir);
    expect(files.length).toBeLessThanOrEqual(10);
  });

  it("cleans up corrupted files during pruning", async () => {
    // Write a valid recent incident
    const recentDate = new Date().toISOString();
    writeIncident(makeRecord({ investigatedAt: recentDate }));

    // Write a corrupted file
    const dir = path.join(tmpDir, ".dops", "incidents", "payments-api");
    fs.writeFileSync(path.join(dir, "corrupted.json"), "not valid json{{{");

    // Save another incident — triggers prune which should delete corrupted file
    const newRecord = makeRecord({
      investigatedAt: new Date(Date.now() - 1000).toISOString(),
    });
    await saveIncident(tmpDir, newRecord);

    const files = fs.readdirSync(dir);
    const hasCorrupted = files.some((f) => f === "corrupted.json");
    expect(hasCorrupted).toBe(false);
  });
});

describe("formatIncidentHistory", () => {
  // Fixed reference point for deterministic tests
  const now = new Date("2026-03-09T12:00:00Z");

  it("formats records as prompt-ready text with relative dates", () => {
    const records: IncidentRecord[] = [
      makeRecord({
        investigatedAt: "2026-03-07T12:00:00Z",
        severity: "high",
        summary: "DB pool exhaustion",
        rootCause: "Connection leak",
      }),
      makeRecord({
        investigatedAt: "2026-03-04T12:00:00Z",
        severity: "critical",
        summary: "Full outage",
        rootCause: "Disk full",
      }),
    ];

    const result = formatIncidentHistory(records, now);

    expect(result).toContain("Recent incidents for this service (last 30 days):");
    expect(result).toContain("2 days ago");
    expect(result).toContain("[high]");
    expect(result).toContain("DB pool exhaustion");
    expect(result).toContain("(root cause: Connection leak)");
    expect(result).toContain("5 days ago");
    expect(result).toContain("[critical]");
    expect(result).toContain("Full outage");
    expect(result).toContain("(root cause: Disk full)");
    expect(result).toContain("Consider whether the current anomaly is a recurrence or related to a previous root cause.");
  });

  it("returns empty string when no records", () => {
    expect(formatIncidentHistory([], now)).toBe("");
  });

  it("shows 'today' for incidents less than 1 day old", () => {
    const records: IncidentRecord[] = [
      makeRecord({ investigatedAt: "2026-03-09T10:00:00Z", summary: "Recent issue", rootCause: "Bug" }),
    ];

    const result = formatIncidentHistory(records, now);
    expect(result).toContain("today");
  });

  it("shows '1 day ago' for incidents exactly 1 day old", () => {
    const records: IncidentRecord[] = [
      makeRecord({ investigatedAt: "2026-03-08T12:00:00Z", summary: "Yesterday issue", rootCause: "Config" }),
    ];

    const result = formatIncidentHistory(records, now);
    expect(result).toContain("1 day ago");
  });
});

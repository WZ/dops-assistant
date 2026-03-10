import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { saveIncident, getRecentIncidents, toFilename, type IncidentRecord } from "./store.js";

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

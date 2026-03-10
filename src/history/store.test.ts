import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { saveIncident, type IncidentRecord } from "./store.js";

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

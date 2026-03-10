import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export type IncidentRecord = {
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  rootCause: string;
  trigger: string;
  investigatedAt: string; // ISO 8601
  confidence: "low" | "medium" | "high";
};

// ── Helpers ─────────────────────────────────────────────────────────────────

export function toFilename(isoDate: string): string {
  return isoDate.replace(/:/g, "-") + ".json";
}

function incidentDir(projectRoot: string, service: string): string {
  return path.join(projectRoot, ".dops", "incidents", service);
}

// ── saveIncident ────────────────────────────────────────────────────────────

export function saveIncident(record: IncidentRecord, projectRoot: string): void {
  if (record.severity === "low") return;

  const dir = incidentDir(projectRoot, record.service);
  fs.mkdirSync(dir, { recursive: true });

  const filename = toFilename(record.investigatedAt);
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2));

  pruneIncidents(dir);
}

// ── getRecentIncidents ──────────────────────────────────────────────────────

const MAX_RECENT = 5;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function getRecentIncidents(
  service: string,
  projectRoot: string,
): IncidentRecord[] {
  const dir = incidentDir(projectRoot, service);
  if (!fs.existsSync(dir)) return [];

  const now = Date.now();
  const records: IncidentRecord[] = [];

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const record: IncidentRecord = JSON.parse(raw);
      const age = now - new Date(record.investigatedAt).getTime();
      if (age <= MAX_AGE_MS) {
        records.push(record);
      }
    } catch {
      // skip corrupted files
    }
  }

  records.sort(
    (a, b) =>
      new Date(b.investigatedAt).getTime() - new Date(a.investigatedAt).getTime(),
  );

  return records.slice(0, MAX_RECENT);
}

// ── Pruning ─────────────────────────────────────────────────────────────────

const MAX_FILES = 10;

function pruneIncidents(dir: string): void {
  if (!fs.existsSync(dir)) return;

  const now = Date.now();

  // Read all files with their parsed dates from file content
  type FileEntry = { file: string; investigatedAt: number };
  const entries: FileEntry[] = [];

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const record: IncidentRecord = JSON.parse(raw);
      const ts = new Date(record.investigatedAt).getTime();
      const age = now - ts;

      // Delete files older than 30 days
      if (age > MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        continue;
      }

      entries.push({ file, investigatedAt: ts });
    } catch {
      // skip corrupted files during pruning
    }
  }

  // If still over the cap, delete oldest files
  if (entries.length > MAX_FILES) {
    entries.sort((a, b) => b.investigatedAt - a.investigatedAt);
    for (const entry of entries.slice(MAX_FILES)) {
      fs.unlinkSync(path.join(dir, entry.file));
    }
  }
}

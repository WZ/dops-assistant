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

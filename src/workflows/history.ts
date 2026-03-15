import * as fsp from "node:fs/promises";
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
  return isoDate.replace(/\.\d+/, "").replace(/:/g, "-") + ".json";
}

function incidentDir(projectRoot: string, service: string): string {
  const sanitized = service.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(projectRoot, ".dops", "incidents", sanitized);
}

// ── saveIncident ────────────────────────────────────────────────────────────

export async function saveIncident(projectRoot: string, record: IncidentRecord): Promise<void> {
  if (record.severity === "low") return;

  const dir = incidentDir(projectRoot, record.service);
  await fsp.mkdir(dir, { recursive: true });

  const filename = toFilename(record.investigatedAt);
  await fsp.writeFile(path.join(dir, filename), JSON.stringify(record, null, 2));

  await pruneIncidents(dir);
}

// ── getRecentIncidents ──────────────────────────────────────────────────────

const MAX_RECENT = 5;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function getRecentIncidents(
  projectRoot: string,
  service: string,
): Promise<IncidentRecord[]> {
  const dir = incidentDir(projectRoot, service);

  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const now = Date.now();
  const records: IncidentRecord[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fsp.readFile(path.join(dir, file), "utf-8");
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

async function pruneIncidents(dir: string): Promise<void> {
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return;
  }

  const now = Date.now();

  // Read all files with their parsed dates from file content
  type FileEntry = { file: string; investigatedAt: number };
  const entries: FileEntry[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    let ts: number;
    try {
      const raw = await fsp.readFile(filePath, "utf-8");
      const record: IncidentRecord = JSON.parse(raw);
      ts = new Date(record.investigatedAt).getTime();
    } catch {
      // Corrupted files get epoch-zero so they are cleaned up by age cutoff
      ts = new Date(0).getTime();
    }

    const age = now - ts;

    // Delete files older than 30 days
    if (age > MAX_AGE_MS) {
      await fsp.unlink(filePath);
      continue;
    }

    entries.push({ file, investigatedAt: ts });
  }

  // If still over the cap, delete oldest files
  if (entries.length > MAX_FILES) {
    entries.sort((a, b) => b.investigatedAt - a.investigatedAt);
    for (const entry of entries.slice(MAX_FILES)) {
      await fsp.unlink(path.join(dir, entry.file));
    }
  }
}

// ── formatIncidentHistory ───────────────────────────────────────────────────

function relativeDate(isoDate: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(isoDate).getTime()) / (24 * 60 * 60 * 1000));
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

export function formatIncidentHistory(records: IncidentRecord[], now: Date = new Date()): string {
  if (records.length === 0) return "";

  const header = "Recent incidents for this service (last 30 days):";
  const footer = "\nConsider whether the current anomaly is a recurrence or related to a previous root cause.";

  const lines = records
    .map(
      (r) =>
        `- ${relativeDate(r.investigatedAt, now)} [${r.severity}] ${r.summary} (root cause: ${r.rootCause})`,
    )
    .join("\n");

  return header + "\n" + lines + footer;
}

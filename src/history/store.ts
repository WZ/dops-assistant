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

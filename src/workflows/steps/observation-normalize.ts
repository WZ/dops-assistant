/**
 * Normalize the per-phase evidence observation shapes (metrics / logs / infra /
 * changes) into the flat `NormalizedObservation[]` the corroboration predicate
 * consumes. Pure + defensive: evidence observations are `z.unknown()` and may be
 * strings or partial objects, so every field access is guarded.
 */

import { parseMetricValue, type NormalizedObservation } from "./corroboration.js";

interface PhaseEvidence {
  observations?: unknown[];
}

interface EvidenceBundle {
  metrics?: PhaseEvidence;
  logs?: PhaseEvidence;
  infra?: PhaseEvidence;
  changes?: PhaseEvidence;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

function normalizeMetric(o: unknown): NormalizedObservation | null {
  if (typeof o === "string") return { phase: "metrics", subject: o };
  if (!isObj(o)) return null;
  const subject = str(o["metric"]) ?? str(o["name"]);
  if (!subject) return null;
  const value = parseMetricValue(o["currentValue"] as string | number | undefined)
    ?? parseMetricValue(o["current"] as string | number | undefined)
    ?? parseMetricValue(o["value"] as string | number | undefined);
  return { phase: "metrics", subject, value, text: str(o["severity"]) };
}

function normalizeLog(o: unknown): NormalizedObservation | null {
  if (typeof o === "string") return { phase: "logs", subject: o, text: o };
  if (!isObj(o)) return null;
  const subject = str(o["pattern"]) ?? str(o["message"]);
  if (!subject) return null;
  const lines = Array.isArray(o["sampleLines"]) ? (o["sampleLines"] as unknown[]).filter((x): x is string => typeof x === "string").join(" ") : undefined;
  return {
    phase: "logs",
    subject,
    text: str(o["sample"]) ?? lines ?? subject,
    timestamp: str(o["firstSeen"]) ?? str(o["lastSeen"]),
  };
}

function normalizeInfra(o: unknown): NormalizedObservation | null {
  if (typeof o === "string") return { phase: "infra", subject: o, text: o };
  if (!isObj(o)) return null;
  const subject = str(o["resource"]) ?? str(o["name"]);
  if (!subject) return null;
  const status = str(o["status"]) ?? "";
  const detail = str(o["detail"]) ?? "";
  return {
    phase: "infra",
    subject,
    text: [status, detail].filter(Boolean).join(" ") || undefined,
    timestamp: str(o["timestamp"]) ?? str(o["time"]),
  };
}

function normalizeChange(o: unknown): NormalizedObservation | null {
  if (typeof o === "string") return { phase: "changes", subject: o, text: o };
  if (!isObj(o)) return null;
  const subject = str(o["title"]) ?? str(o["type"]);
  if (!subject) return null;
  const type = str(o["type"]) ?? "";
  const detail = str(o["detail"]) ?? "";
  return {
    phase: "changes",
    subject,
    text: [type, detail].filter(Boolean).join(" ") || undefined,
    timestamp: str(o["timestamp"]) ?? str(o["time"]),
  };
}

/** Flatten an evidence bundle into normalized observations for the predicate. */
export function normalizeObservations(evidence: EvidenceBundle): NormalizedObservation[] {
  const out: NormalizedObservation[] = [];
  const push = (obs: unknown[] | undefined, fn: (o: unknown) => NormalizedObservation | null) => {
    for (const o of obs ?? []) {
      const n = fn(o);
      if (n) out.push(n);
    }
  };
  push(evidence.metrics?.observations, normalizeMetric);
  push(evidence.logs?.observations, normalizeLog);
  push(evidence.infra?.observations, normalizeInfra);
  push(evidence.changes?.observations, normalizeChange);
  return out;
}

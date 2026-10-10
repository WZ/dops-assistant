/**
 * Fill evidence categories the synthesis model left empty from that phase's raw
 * observations. Models (especially reasoning models) sometimes drop a whole
 * category despite the prompt's self-check, which leaves the report and the UI
 * without evidence the investigation actually gathered.
 */
import { normalizeObservations } from "./observation-normalize.js";
import type { NormalizedObservation } from "./corroboration.js";

const MAX_ITEMS = 10;
const MAX_CHARS = 300;

type Category = "metrics" | "logs" | "infra" | "changes";
type Evidence = Record<Category, string[]>;
type Findings = Partial<Record<Category, { observations?: unknown[] } | undefined>>;

function format(o: NormalizedObservation): string {
  const ts = o.timestamp ? `[${o.timestamp}] ` : "";
  let body: string;
  if (o.phase === "metrics") {
    body = `${o.subject}${o.value !== undefined ? ` = ${o.value}` : ""}${o.text ? ` (${o.text})` : ""}`;
  } else {
    body = o.text && o.text !== o.subject ? `${o.subject}: ${o.text}` : o.subject;
  }
  const line = ts + body;
  return line.length > MAX_CHARS ? `${line.slice(0, MAX_CHARS - 1)}…` : line;
}

export function backfillEmptyEvidence(evidence: Evidence, findings: Findings): Evidence {
  const normalized = normalizeObservations({
    metrics: { observations: findings.metrics?.observations },
    logs: { observations: findings.logs?.observations },
    infra: { observations: findings.infra?.observations },
    changes: { observations: findings.changes?.observations },
  });
  const out: Evidence = { ...evidence };
  for (const category of ["metrics", "logs", "infra", "changes"] as const) {
    if ((out[category] ?? []).length > 0) continue;
    out[category] = normalized.filter((o) => o.phase === category).slice(0, MAX_ITEMS).map(format);
  }
  return out;
}

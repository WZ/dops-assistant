/**
 * rca-eval.ts — RCA report quality scoring CLI
 *
 * Usage:
 *   npx tsx src/eval/rca-eval.ts
 *   npx tsx src/eval/rca-eval.ts --save
 *   npx tsx src/eval/rca-eval.ts --compare src/eval/baselines/2026-03-01.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { RcaReport } from "../types/rca-types.js";

// ── Regex constants ────────────────────────────────────────────────────────

const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}/;
const NUMERIC_VALUE_RE = /\d+\.?\d*\s*(req|ms|%|MB|GB|s\/s|k\/s)/i;
const VAGUE_ROOT_CAUSE_RE = /unable to determine|under investigation/i;
const VAGUE_TRIGGER_RE = /^unknown$|^$/i;

// ── Scoring functions (exported for unit tests) ────────────────────────────

/**
 * Dimension 1: Root cause specificity (0 | 10 | 20)
 */
export function scoreRootCause(report: RcaReport): number {
  const rc = (report.rootCause ?? "").trim();
  if (!rc || VAGUE_ROOT_CAUSE_RE.test(rc)) return 0;
  if (rc.length < 50) return 10;
  return 20;
}

/**
 * Dimension 2: Evidence quality (0 | 10 | 20)
 *
 * Checks whether evidence items contain timestamps or specific numeric values.
 */
export function scoreEvidence(report: RcaReport): number {
  const ev = report.evidence ?? { metrics: [], logs: [], infra: [] };
  const all: string[] = [
    ...(ev.metrics ?? []),
    ...(ev.logs ?? []),
    ...(ev.infra ?? []),
  ];

  if (all.length === 0) return 0;

  const richCount = all.filter(
    (item) => TIMESTAMP_RE.test(item) || NUMERIC_VALUE_RE.test(item)
  ).length;

  if (richCount / all.length >= 0.5) return 20;
  return 10;
}

/**
 * Dimension 3: Trigger identification (0 | 10 | 20)
 */
export function scoreTrigger(report: RcaReport): number {
  const t = (report.trigger ?? "").trim();
  if (!t || VAGUE_TRIGGER_RE.test(t)) return 0;
  if (t.length < 30 || !TIMESTAMP_RE.test(t)) return 10;
  return 20;
}

/**
 * Dimension 4: Actionability (0 | 10 | 20)
 */
export function scoreActionability(report: RcaReport): number {
  const actions = report.recommendedActions ?? [];
  if (actions.length === 0) return 0;
  if (actions.length >= 3) return 20;
  return 10;
}

/**
 * Dimension 5: Factual grounding (0 | 10 | 20)
 *
 * Based purely on total evidence item count.
 */
export function scoreFactualGrounding(report: RcaReport): number {
  const ev = report.evidence ?? { metrics: [], logs: [], infra: [] };
  const total =
    (ev.metrics ?? []).length +
    (ev.logs ?? []).length +
    (ev.infra ?? []).length;

  if (total === 0) return 0;
  if (total <= 2) return 10;
  return 20;
}

// ── Aggregate scorer ───────────────────────────────────────────────────────

export interface ScoreResult {
  rootCause: number;
  evidence: number;
  trigger: number;
  actionability: number;
  factualGrounding: number;
  total: number;
  pass: boolean;
}

export function scoreReport(report: RcaReport): ScoreResult {
  const rootCause = scoreRootCause(report);
  const evidence = scoreEvidence(report);
  const trigger = scoreTrigger(report);
  const actionability = scoreActionability(report);
  const factualGrounding = scoreFactualGrounding(report);
  const total = rootCause + evidence + trigger + actionability + factualGrounding;
  return {
    rootCause,
    evidence,
    trigger,
    actionability,
    factualGrounding,
    total,
    pass: total >= 70,
  };
}

// ── Baseline record type ───────────────────────────────────────────────────

interface BaselineEntry {
  id: string;
  service: string;
  createdAt: string | null;
  scores: ScoreResult;
}

interface Baseline {
  generatedAt: string;
  entries: BaselineEntry[];
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function fmtScore(score: number): string {
  return String(score).padStart(2);
}

function fmtDelta(current: number, baseline: number): string {
  const d = current - baseline;
  if (d === 0) return "  =";
  return d > 0 ? `+${d}`.padStart(3) : String(d).padStart(3);
}

function renderTable(entries: BaselineEntry[], baseline?: Baseline): void {
  const COL_ID = 36;
  const COL_SVC = 18;

  const header = [
    pad("ID", COL_ID),
    pad("Service", COL_SVC),
    "RC ",
    "Ev ",
    "Tr ",
    "Ac ",
    "FG ",
    "Tot",
    "Pass",
  ].join("  ");

  console.log("\n" + header);
  console.log("-".repeat(header.length));

  for (const entry of entries) {
    const s = entry.scores;
    let baselineEntry: BaselineEntry | undefined;
    if (baseline) {
      baselineEntry = baseline.entries.find((b) => b.id === entry.id);
    }

    const rcCol = baselineEntry
      ? `${fmtScore(s.rootCause)}(${fmtDelta(s.rootCause, baselineEntry.scores.rootCause)})`
      : fmtScore(s.rootCause);
    const evCol = baselineEntry
      ? `${fmtScore(s.evidence)}(${fmtDelta(s.evidence, baselineEntry.scores.evidence)})`
      : fmtScore(s.evidence);
    const trCol = baselineEntry
      ? `${fmtScore(s.trigger)}(${fmtDelta(s.trigger, baselineEntry.scores.trigger)})`
      : fmtScore(s.trigger);
    const acCol = baselineEntry
      ? `${fmtScore(s.actionability)}(${fmtDelta(s.actionability, baselineEntry.scores.actionability)})`
      : fmtScore(s.actionability);
    const fgCol = baselineEntry
      ? `${fmtScore(s.factualGrounding)}(${fmtDelta(s.factualGrounding, baselineEntry.scores.factualGrounding)})`
      : fmtScore(s.factualGrounding);
    const totCol = baselineEntry
      ? `${String(s.total).padStart(3)}(${fmtDelta(s.total, baselineEntry.scores.total)})`
      : String(s.total).padStart(3);

    console.log(
      [
        pad(entry.id, COL_ID),
        pad(entry.service, COL_SVC),
        rcCol,
        evCol,
        trCol,
        acCol,
        fgCol,
        totCol,
        s.pass ? "PASS" : "FAIL",
      ].join("  ")
    );
  }

  const passed = entries.filter((e) => e.scores.pass).length;
  const total = entries.length;
  const avgTotal =
    total > 0
      ? Math.round(
          entries.reduce((sum, e) => sum + e.scores.total, 0) / total
        )
      : 0;

  console.log("-".repeat(header.length));
  console.log(
    `\nSummary: ${passed}/${total} PASS  |  avg score: ${avgTotal}/100\n`
  );
}

// ── CLI entry point ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const saveFlag = args.includes("--save");
  const compareIdx = args.indexOf("--compare");
  const compareFile = compareIdx !== -1 ? args[compareIdx + 1] : undefined;

  // Dynamic import to keep scoring functions importable without better-sqlite3
  const { Database } = await import("../server/db.js");

  const dbPath = process.env.DB_PATH ?? "dops.sqlite";
  const db = new Database(dbPath);

  let rows: Array<{ id: string; service: string; report: string | null; created_at: string }>;
  try {
    rows = db
      .listInvestigations(10_000, 0)
      .filter((r) => r.status === "complete" && r.report !== null) as typeof rows;
  } finally {
    db.close();
  }

  const entries: BaselineEntry[] = [];

  for (const row of rows) {
    let report: RcaReport;
    try {
      report = JSON.parse(row.report!) as RcaReport;
    } catch {
      console.warn(`Skipping investigation ${row.id}: failed to parse report JSON`);
      continue;
    }

    entries.push({
      id: row.id,
      service: row.service,
      createdAt: row.created_at ?? null,
      scores: scoreReport(report),
    });
  }

  if (entries.length === 0) {
    console.log("No completed investigations with reports found.");
    return;
  }

  // Load comparison baseline if requested
  let baseline: Baseline | undefined;
  if (compareFile) {
    try {
      baseline = JSON.parse(readFileSync(resolve(compareFile), "utf8")) as Baseline;
      console.log(`Comparing against baseline: ${compareFile} (generated ${baseline.generatedAt})`);
    } catch (err) {
      console.error(`Failed to load baseline file "${compareFile}": ${(err as Error).message}`);
      process.exit(1);
    }
  }

  renderTable(entries, baseline);

  // Save baseline if requested
  if (saveFlag) {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const baselinesDir = resolve(__dirname, "baselines");
    const outPath = resolve(baselinesDir, `${date}.json`);

    mkdirSync(baselinesDir, { recursive: true });

    const output: Baseline = {
      generatedAt: new Date().toISOString(),
      entries,
    };
    writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`Baseline saved to: ${outPath}`);
  }
}

// Guard: only run CLI when executed directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  main().catch((err) => {
    console.error("rca-eval error:", err);
    process.exit(1);
  });
}

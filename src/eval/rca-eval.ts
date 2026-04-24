/**
 * rca-eval.ts — RCA report quality scoring CLI
 *
 * Usage:
 *   npx tsx src/eval/rca-eval.ts
 *   npx tsx src/eval/rca-eval.ts --save
 *   npx tsx src/eval/rca-eval.ts --compare src/eval/baselines/2026-03-01.json
 *   npx tsx src/eval/rca-eval.ts --source scan    # filter by trigger source
 *   npx tsx src/eval/rca-eval.ts --min-score 75   # fail (exit 1) if avg < threshold
 *   npx tsx src/eval/rca-eval.ts --reports src/eval/fixtures/sample-rca-reports.json --min-score 70
 *
 * --source values: all (default) | scan | webhook | user
 * --min-score: integer 0-100. Exits non-zero if the average total falls below it.
 * --reports: JSON file containing an array of RcaReport objects. When set,
 *   the eval reads from the file instead of the local DB. Pair with --min-score
 *   in CI: catches rubric drift without needing a populated dops.sqlite.
 *
 * Source classification is heuristic, based on the `query` column's prefix:
 *   - "Proactive scan detected anomaly"  → scan-triggered (see anomaly-probe.ts)
 *   - "Alert: " (Alertmanager payload)   → webhook-triggered (see webhook-handler.ts)
 *   - anything else                       → user-initiated
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

// ── Trigger-source classification ──────────────────────────────────────────

export type TriggerSource = "scan" | "webhook" | "user";

/**
 * Classify an investigation by its stored `query` column (the message originally
 * passed to InvestigationRunner.run). Scan and webhook messages follow fixed
 * prefixes; anything else is considered user-initiated.
 *
 * Keep in sync with:
 *   - anomaly-probe.ts buildInvestigationMessage (scan prefix)
 *   - webhook-handler.ts messageParts[0] (webhook prefix)
 */
export function classifyTriggerSource(query: string): TriggerSource {
  if (query.startsWith("Proactive scan detected anomaly")) return "scan";
  if (query.startsWith("Alert: ")) return "webhook";
  return "user";
}

// ── Baseline record type ───────────────────────────────────────────────────

interface BaselineEntry {
  id: string;
  service: string;
  createdAt: string | null;
  source: TriggerSource;
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
  const COL_SRC = 8;

  const header = [
    pad("ID", COL_ID),
    pad("Service", COL_SVC),
    pad("Source", COL_SRC),
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
        pad(entry.source, COL_SRC),
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

  // Per-source breakdown: helps operators see whether scan-triggered RCAs
  // are meeting the ≥60 design-doc criterion without pulling DB manually.
  const bySource: Record<TriggerSource, BaselineEntry[]> = { scan: [], webhook: [], user: [] };
  for (const e of entries) bySource[e.source].push(e);

  console.log("-".repeat(header.length));
  console.log(
    `\nSummary: ${passed}/${total} PASS  |  avg score: ${avgTotal}/100`
  );
  for (const src of ["scan", "webhook", "user"] as TriggerSource[]) {
    const group = bySource[src];
    if (group.length === 0) continue;
    const avg = Math.round(group.reduce((a, e) => a + e.scores.total, 0) / group.length);
    const p = group.filter((e) => e.scores.pass).length;
    console.log(`  ${pad(src, 8)}  ${p}/${group.length} PASS  |  avg: ${avg}/100`);
  }
  console.log("");
}

// ── CLI entry point ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const saveFlag = args.includes("--save");
  const compareIdx = args.indexOf("--compare");
  const compareFile = compareIdx !== -1 ? args[compareIdx + 1] : undefined;
  const sourceIdx = args.indexOf("--source");
  const sourceArg = sourceIdx !== -1 ? args[sourceIdx + 1] : "all";
  const minScoreIdx = args.indexOf("--min-score");
  const minScoreRaw = minScoreIdx !== -1 ? args[minScoreIdx + 1] : undefined;
  const minScore = minScoreRaw !== undefined ? Number(minScoreRaw) : undefined;
  const reportsIdx = args.indexOf("--reports");
  const reportsFile = reportsIdx !== -1 ? args[reportsIdx + 1] : undefined;
  if (minScoreRaw !== undefined && (!Number.isFinite(minScore) || minScore! < 0 || minScore! > 100)) {
    console.error(`Invalid --min-score value: ${minScoreRaw}. Expected a number between 0 and 100.`);
    process.exit(1);
  }
  const validSources = new Set(["all", "scan", "webhook", "user"]);
  if (!validSources.has(sourceArg ?? "all")) {
    console.error(`Invalid --source value: ${sourceArg}. Expected one of: all, scan, webhook, user`);
    process.exit(1);
  }
  const sourceFilter = sourceArg === "all" ? null : (sourceArg as TriggerSource);

  const entries: BaselineEntry[] = [];

  if (reportsFile) {
    // CI / fixture mode: score reports loaded from a JSON file. The fixture
    // is a stable artifact in src/eval/fixtures/, so this path doesn't need
    // a populated dops.sqlite and can run on a fresh runner. Catches rubric
    // regressions and shape changes without depending on live DB state.
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(resolve(reportsFile), "utf8"));
    } catch (err) {
      console.error(`Failed to load reports file "${reportsFile}": ${(err as Error).message}`);
      process.exit(1);
    }
    if (!Array.isArray(parsed)) {
      console.error(`Reports file "${reportsFile}" must contain a JSON array of RcaReport objects.`);
      process.exit(1);
    }
    const items = parsed as Array<{ id?: string; source?: TriggerSource; report?: RcaReport } | RcaReport>;
    for (let i = 0; i < items.length; i++) {
      const raw = items[i]!;
      // Accept two shapes: a bare RcaReport, or { id?, source?, report }.
      const report: RcaReport = "report" in raw && (raw as { report?: RcaReport }).report
        ? (raw as { report: RcaReport }).report
        : (raw as RcaReport);
      const id = (raw as { id?: string }).id ?? `fixture-${i + 1}`;
      const explicitSource = (raw as { source?: TriggerSource }).source;
      const source: TriggerSource = explicitSource ?? "scan";
      if (sourceFilter && source !== sourceFilter) continue;
      entries.push({
        id,
        service: report.service ?? "unknown",
        createdAt: report.investigatedAt ?? null,
        source,
        scores: scoreReport(report),
      });
    }
  } else {
    // Live-DB mode: read completed investigations from the local sqlite. The
    // default mode used during dev / pre-ship.
    // Dynamic import to keep scoring functions importable without better-sqlite3
    const { Database } = await import("../server/db.js");

    const dbPath = process.env.DB_PATH ?? "dops.sqlite";
    const db = new Database(dbPath);

    let rows: Array<{ id: string; service: string; query: string; report: string | null; created_at: string }>;
    try {
      // Find the default stack to read its investigations
      const { DEFAULT_STACK_SLUG } = await import("../types/stack-types.js");
      const defaultStack = db.getStackBySlug(DEFAULT_STACK_SLUG);
      const stackId = defaultStack?.id ?? "";
      rows = db
        .listInvestigations(stackId, { limit: 10_000, status: ["complete"] })
        .filter((r) => r.report !== null) as typeof rows;
    } finally {
      db.close();
    }

    for (const row of rows) {
      let report: RcaReport;
      try {
        report = JSON.parse(row.report!) as RcaReport;
      } catch {
        console.warn(`Skipping investigation ${row.id}: failed to parse report JSON`);
        continue;
      }

      const source = classifyTriggerSource(row.query ?? "");
      if (sourceFilter && source !== sourceFilter) continue;

      entries.push({
        id: row.id,
        service: row.service,
        createdAt: row.created_at ?? null,
        source,
        scores: scoreReport(report),
      });
    }
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

  // Gate on minimum score — for CI / pre-ship quality checks.
  // Exits non-zero when the average total falls below the configured floor.
  if (minScore !== undefined) {
    const avgTotal = Math.round(
      entries.reduce((a, e) => a + e.scores.total, 0) / entries.length,
    );
    if (avgTotal < minScore) {
      console.error(
        `\nFAIL: average score ${avgTotal}/100 is below --min-score ${minScore}/100`,
      );
      process.exit(1);
    }
    console.log(`\nPASS: average score ${avgTotal}/100 meets --min-score ${minScore}/100`);
  }

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

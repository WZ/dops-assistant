/**
 * deep-eval.ts — deep-investigation (autonomous orchestrator) quality scoring CLI
 *
 * The orchestrator is LLM-driven and non-deterministic: the same incident can
 * confirm the right cause, wall-clock, or confirm a wrong one on different runs.
 * Eyeballing a manual batch can't tell whether a change helped. This harness
 * turns a batch of orchestrator runs into objective rates so accuracy regressions
 * (category errors, fabrications, confident-wrong confirms) are measured, not guessed.
 *
 * It scores RUN RESULTS (not live execution) so it's fast and deterministic. Produce
 * the results with the live runner, then score them here.
 *
 * Usage:
 *   npx tsx src/eval/deep-eval.ts --results /tmp/orch-batch-results.json
 *   npx tsx src/eval/deep-eval.ts --results runs.json --save
 *   npx tsx src/eval/deep-eval.ts --results runs.json --compare src/eval/baselines/deep-2026-06-11.json
 *   npx tsx src/eval/deep-eval.ts --results runs.json --max-confident-wrong 0 --min-correct 50
 *
 * Results file: a JSON array of run objects. Only three fields are read:
 *   { "service": "<name>", "outcome": "confirmed|wall-clock|...", "rootCause": "<text|null>" }
 * (the live runner's output is a superset of this — it is read directly).
 *
 * Gates (CI):
 *   --max-confident-wrong N : exit 1 if confident-wrong runs exceed N (default: off)
 *   --max-category-error  N : exit 1 if category-error runs exceed N (default: off)
 *   --min-correct       PCT : exit 1 if correct-rate (of labeled runs) is below PCT
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IncidentLabel {
  service: string;
  infraType: string;
  summary?: string;
  /** A confirmed cause is CORRECT if its text contains any of these (case-insensitive). */
  expectedCauseKeywords: string[];
  /** A confirmed cause is clearly WRONG if its text contains any of these — a
   *  cross-infra-type category error or a fabrication for this service. */
  wrongCausePatterns: string[];
  /** Non-confirmed outcomes that are HONEST (not a quality failure) for this incident. */
  acceptableInconclusive: string[];
}

export interface DeepRun {
  service: string;
  outcome?: string | null;
  rootCause?: string | null;
}

export type RunVerdict =
  | "correct" // confirmed AND matches an expected cause AND no wrong pattern
  | "confident-wrong" // confirmed but not correct (category error / fabrication / off-target)
  | "honest-inconclusive" // not confirmed, and the outcome is an acceptable decline
  | "unexpected-inconclusive" // not confirmed, but the outcome wasn't listed acceptable
  | "unlabeled"; // no label for this service — can't score

export interface RunScore {
  service: string;
  outcome: string;
  rootCause: string | null;
  verdict: RunVerdict;
  /** confident-wrong specifically because the cause names the other infra type. */
  categoryError: boolean;
  /** confident-wrong specifically because the cause matched a flagged wrong pattern. */
  matchedWrongPattern: string | null;
}

export interface Scorecard {
  total: number;
  labeled: number;
  correct: number;
  confidentWrong: number;
  categoryError: number;
  honestInconclusive: number;
  unexpectedInconclusive: number;
  unlabeled: number;
  /** correct / labeled, as a 0–100 integer (0 when no labeled runs). */
  correctRate: number;
  /** confidentWrong / labeled, 0–100. The "do no harm" bar — target 0. */
  confidentWrongRate: number;
  perService: Record<string, { runs: number; correct: number; confidentWrong: number }>;
  runs: RunScore[];
}

// ── Scoring (pure, exported for tests) ───────────────────────────────────────

const norm = (s: string | null | undefined): string => (s ?? "").toLowerCase();

function firstMatch(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    if (n && haystack.includes(n.toLowerCase())) return n;
  }
  return null;
}

/** Score one run against its label. */
export function scoreRun(run: DeepRun, label: IncidentLabel | undefined): RunScore {
  const outcome = (run.outcome ?? "").toLowerCase() || "unknown";
  const cause = run.rootCause ?? null;
  const base = { service: run.service, outcome, rootCause: cause };

  if (!label) {
    return { ...base, verdict: "unlabeled", categoryError: false, matchedWrongPattern: null };
  }

  if (outcome !== "confirmed") {
    const honest = label.acceptableInconclusive.map((s) => s.toLowerCase()).includes(outcome);
    return {
      ...base,
      verdict: honest ? "honest-inconclusive" : "unexpected-inconclusive",
      categoryError: false,
      matchedWrongPattern: null,
    };
  }

  // Confirmed: judge the cause text.
  const text = norm(cause);
  const wrong = firstMatch(text, label.wrongCausePatterns);
  const hasExpected = firstMatch(text, label.expectedCauseKeywords) !== null;
  const correct = hasExpected && !wrong;
  // A category error is a wrong confirm that names the OTHER infra type. We treat
  // any matched wrong pattern as the trigger; the distinction in reporting is
  // whether the matched pattern is an infra-type term vs. a fabrication term, but
  // for the headline rate both are "confident-wrong".
  const INFRA_TYPE_TERMS = ["kubernetes", "k8s", "consul", "namespace", "deployment"];
  const categoryError = wrong !== null && INFRA_TYPE_TERMS.some((t) => wrong.toLowerCase().includes(t));

  return {
    ...base,
    verdict: correct ? "correct" : "confident-wrong",
    categoryError,
    matchedWrongPattern: wrong,
  };
}

/** Aggregate a batch of runs against the label set. */
export function scoreRuns(runs: DeepRun[], labels: IncidentLabel[]): Scorecard {
  const byService = new Map(labels.map((l) => [l.service, l]));
  const scored = runs.map((r) => scoreRun(r, byService.get(r.service)));

  const card: Scorecard = {
    total: scored.length,
    labeled: scored.filter((s) => s.verdict !== "unlabeled").length,
    correct: scored.filter((s) => s.verdict === "correct").length,
    confidentWrong: scored.filter((s) => s.verdict === "confident-wrong").length,
    categoryError: scored.filter((s) => s.categoryError).length,
    honestInconclusive: scored.filter((s) => s.verdict === "honest-inconclusive").length,
    unexpectedInconclusive: scored.filter((s) => s.verdict === "unexpected-inconclusive").length,
    unlabeled: scored.filter((s) => s.verdict === "unlabeled").length,
    correctRate: 0,
    confidentWrongRate: 0,
    perService: {},
    runs: scored,
  };
  if (card.labeled > 0) {
    card.correctRate = Math.round((card.correct / card.labeled) * 100);
    card.confidentWrongRate = Math.round((card.confidentWrong / card.labeled) * 100);
  }
  for (const s of scored) {
    if (s.verdict === "unlabeled") continue;
    const ps = (card.perService[s.service] ??= { runs: 0, correct: 0, confidentWrong: 0 });
    ps.runs++;
    if (s.verdict === "correct") ps.correct++;
    if (s.verdict === "confident-wrong") ps.confidentWrong++;
  }
  return card;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function loadLabels(): IncidentLabel[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(resolve(here, "fixtures/deep-investigation-labels.json"), "utf-8"));
  return raw.labels as IncidentLabel[];
}

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function printCard(card: Scorecard): void {
  const pad = (n: number) => String(n).padStart(3);
  console.log("\n=== Deep-investigation eval ===");
  console.log(`runs: ${card.total}  (labeled ${card.labeled}, unlabeled ${card.unlabeled})`);
  console.log(`  ✓ correct              ${pad(card.correct)}   (${card.correctRate}% of labeled)`);
  console.log(`  ✗ confident-wrong      ${pad(card.confidentWrong)}   (${card.confidentWrongRate}% of labeled)  ← target 0`);
  console.log(`      of which category-error ${pad(card.categoryError)}`);
  console.log(`  ◐ honest-inconclusive  ${pad(card.honestInconclusive)}`);
  console.log(`  ? unexpected-inconclusive ${pad(card.unexpectedInconclusive)}`);
  console.log("\nper service:");
  for (const [svc, ps] of Object.entries(card.perService)) {
    console.log(`  ${svc}: ${ps.correct}/${ps.runs} correct, ${ps.confidentWrong} confident-wrong`);
  }
  const wrong = card.runs.filter((r) => r.verdict === "confident-wrong");
  if (wrong.length) {
    console.log("\nconfident-wrong confirms:");
    for (const r of wrong) {
      console.log(`  ✗ ${r.service}: "${r.rootCause}"${r.matchedWrongPattern ? `  [matched "${r.matchedWrongPattern}"]` : ""}`);
    }
  }
}

function main(): void {
  const resultsPath = getFlag("--results");
  if (!resultsPath) {
    console.error("error: --results <file> is required (a JSON array of run objects)");
    process.exit(2);
  }
  const runs = JSON.parse(readFileSync(resolve(resultsPath), "utf-8")) as DeepRun[];
  if (!Array.isArray(runs)) {
    console.error("error: results file must be a JSON array");
    process.exit(2);
  }
  const labels = loadLabels();
  const card = scoreRuns(runs, labels);
  printCard(card);

  if (process.argv.includes("--save")) {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = resolve(here, "baselines");
    mkdirSync(dir, { recursive: true });
    const summary = {
      correctRate: card.correctRate,
      confidentWrongRate: card.confidentWrongRate,
      correct: card.correct,
      confidentWrong: card.confidentWrong,
      categoryError: card.categoryError,
      labeled: card.labeled,
      perService: card.perService,
    };
    const out = resolve(dir, "deep-latest.json");
    writeFileSync(out, JSON.stringify(summary, null, 2));
    console.log(`\nsaved baseline → ${out}`);
  }

  const comparePath = getFlag("--compare");
  if (comparePath) {
    const base = JSON.parse(readFileSync(resolve(comparePath), "utf-8"));
    const d = (k: "correctRate" | "confidentWrongRate") => card[k] - (base[k] ?? 0);
    console.log(`\nvs baseline ${comparePath}:`);
    console.log(`  correctRate:       ${base.correctRate ?? "?"}% → ${card.correctRate}%  (${d("correctRate") >= 0 ? "+" : ""}${d("correctRate")})`);
    console.log(`  confidentWrongRate ${base.confidentWrongRate ?? "?"}% → ${card.confidentWrongRate}%  (${d("confidentWrongRate") >= 0 ? "+" : ""}${d("confidentWrongRate")})`);
  }

  // Gates
  let failed = false;
  const maxCW = getFlag("--max-confident-wrong");
  if (maxCW !== undefined && card.confidentWrong > Number(maxCW)) {
    console.error(`\nGATE FAIL: confident-wrong ${card.confidentWrong} > ${maxCW}`);
    failed = true;
  }
  const maxCE = getFlag("--max-category-error");
  if (maxCE !== undefined && card.categoryError > Number(maxCE)) {
    console.error(`GATE FAIL: category-error ${card.categoryError} > ${maxCE}`);
    failed = true;
  }
  const minCorrect = getFlag("--min-correct");
  if (minCorrect !== undefined && card.correctRate < Number(minCorrect)) {
    console.error(`GATE FAIL: correctRate ${card.correctRate}% < ${minCorrect}%`);
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}

// Only run main() as a CLI, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

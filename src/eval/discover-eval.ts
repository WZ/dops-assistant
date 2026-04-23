/**
 * discover-eval.ts — discovery agent output quality scoring CLI
 *
 * Usage:
 *   npx tsx src/eval/discover-eval.ts                              # scores services.yaml in cwd
 *   npx tsx src/eval/discover-eval.ts --input path/to/services.yaml
 *   npx tsx src/eval/discover-eval.ts --input fixture.json --fixture
 *   npx tsx src/eval/discover-eval.ts --min-score 75               # exits non-zero below threshold
 *
 * The eval scores what Slice B of the discovery-owned probe rules change
 * produces: per-service `probeRules` and top-level `globalProbeRules` written
 * by the LLM into `services.yaml`. A prompt regression (the agent stops
 * emitting these fields) shows up immediately in the score; a silently-
 * degraded run (wrong label key, unparseable query) shows up too.
 *
 * Four 25-point dimensions:
 *   1. Global rules present   — non-empty `globalProbeRules`.
 *   2. Per-service rules      — at least one service with non-empty `probeRules`.
 *   3. PromQL parses          — every metrics-source rule passes a lightweight
 *                               syntax check (balanced braces, has a metric
 *                               identifier, no obvious placeholder tokens).
 *   4. LogQL parses           — same for logs-source rules (`{selectors}`
 *                               present, pipeline operators balanced).
 *
 * The parsers are deliberately shallow — a full PromQL / LogQL parser is
 * out of scope. The eval catches the failures that matter: empty output,
 * placeholder strings like "YOUR_NAMESPACE", missing braces. Slice C's
 * runtime NaN fail-safe catches the deeper "query runs but returns
 * nothing" case.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import type { ProbeMetricRule, ServiceConfig } from "../config/schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface DiscoverInput {
  services: ServiceConfig[];
  globalProbeRules: ProbeMetricRule[];
}

export interface DimensionScore {
  name: string;
  score: number;    // 0..25
  max: 25;
  notes: string[];
}

export interface EvalResult {
  total: number;          // 0..100
  dimensions: DimensionScore[];
  summary: string;
}

// ── Input loading ────────────────────────────────────────────────────────────

/**
 * Load a services.yaml or JSON fixture and normalize to DiscoverInput.
 * Forward-compat with the legacy flat-array services.yaml (pre-Slice-A) —
 * parses as `{services: [...], globalProbeRules: []}` so a pre-upgrade file
 * scores zero on dimension 1 (no globals yet) rather than crashing.
 */
export function loadInput(path: string, fixture: boolean = false): DiscoverInput {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const raw = readFileSync(path, "utf-8");
  const parsed = fixture ? JSON.parse(raw) : parseYaml(raw);
  if (Array.isArray(parsed)) {
    // Legacy flat-array services.yaml.
    return { services: parsed as ServiceConfig[], globalProbeRules: [] };
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { services?: unknown; globalProbeRules?: unknown };
    return {
      services: Array.isArray(obj.services) ? (obj.services as ServiceConfig[]) : [],
      globalProbeRules: Array.isArray(obj.globalProbeRules)
        ? (obj.globalProbeRules as ProbeMetricRule[])
        : [],
    };
  }
  return { services: [], globalProbeRules: [] };
}

// ── Lightweight query parsers (exported for unit tests) ──────────────────────

// Catches common LLM placeholder strings that slip through the prompt —
// discovery should never emit these literally.
const PLACEHOLDER_RE = /YOUR_|REPLACE_ME|TODO|PLACEHOLDER|\$\{[^}]*\}|<[a-z_]+>/i;

/**
 * Lightweight PromQL syntax check. Not a real parser — just catches the
 * failure modes an LLM actually produces: empty string, unbalanced braces,
 * missing metric identifier, placeholder tokens. A string that passes this
 * check may still be semantically wrong (wrong metric name, wrong label).
 */
export function parsesAsPromQL(query: string): { ok: boolean; reason?: string } {
  if (!query || query.trim().length === 0) return { ok: false, reason: "empty" };
  if (PLACEHOLDER_RE.test(query)) return { ok: false, reason: "contains placeholder" };
  // Metric identifier: at least one [a-z_][a-z_0-9:]* token outside string literals.
  if (!/[a-z_][a-z_0-9:]*/i.test(query)) return { ok: false, reason: "no metric identifier" };
  // Balanced braces.
  const open = (query.match(/\{/g) ?? []).length;
  const close = (query.match(/\}/g) ?? []).length;
  if (open !== close) return { ok: false, reason: `unbalanced braces: ${open} open, ${close} close` };
  // Balanced parens (rate(), sum(), etc.).
  const openP = (query.match(/\(/g) ?? []).length;
  const closeP = (query.match(/\)/g) ?? []).length;
  if (openP !== closeP) return { ok: false, reason: `unbalanced parens: ${openP} open, ${closeP} close` };
  return { ok: true };
}

/**
 * Lightweight LogQL syntax check. Expects a stream selector `{label="value",...}`
 * as the leftmost token, optionally followed by pipeline operators.
 */
export function parsesAsLogQL(query: string): { ok: boolean; reason?: string } {
  if (!query || query.trim().length === 0) return { ok: false, reason: "empty" };
  if (PLACEHOLDER_RE.test(query)) return { ok: false, reason: "contains placeholder" };
  // Must contain a `{...}` stream selector somewhere.
  const open = (query.match(/\{/g) ?? []).length;
  const close = (query.match(/\}/g) ?? []).length;
  if (open === 0 || close === 0) return { ok: false, reason: "no {selector}" };
  if (open !== close) return { ok: false, reason: `unbalanced braces: ${open} open, ${close} close` };
  // Balanced parens.
  const openP = (query.match(/\(/g) ?? []).length;
  const closeP = (query.match(/\)/g) ?? []).length;
  if (openP !== closeP) return { ok: false, reason: `unbalanced parens: ${openP} open, ${closeP} close` };
  return { ok: true };
}

// ── Dimension scoring ────────────────────────────────────────────────────────

export function scoreGlobalsPresent(input: DiscoverInput): DimensionScore {
  const n = input.globalProbeRules.length;
  if (n === 0) return { name: "globals_present", score: 0, max: 25, notes: ["globalProbeRules is empty — stack label-key introspection missing"] };
  return { name: "globals_present", score: 25, max: 25, notes: [`${n} global rule(s)`] };
}

export function scorePerServicePresent(input: DiscoverInput): DimensionScore {
  const withRules = input.services.filter((s) => (s.probeRules ?? []).length > 0);
  if (withRules.length === 0) {
    return { name: "per_service_present", score: 0, max: 25, notes: ["no service has non-empty probeRules"] };
  }
  // Partial credit: at least one gets 15, majority gets 25.
  const ratio = withRules.length / Math.max(1, input.services.length);
  const score = ratio >= 0.5 ? 25 : 15;
  return {
    name: "per_service_present",
    score,
    max: 25,
    notes: [`${withRules.length}/${input.services.length} services have probeRules (${Math.round(ratio * 100)}%)`],
  };
}

/** Collect every metrics-source rule across globals + per-service. */
function allMetricRules(input: DiscoverInput): ProbeMetricRule[] {
  const out: ProbeMetricRule[] = [];
  for (const r of input.globalProbeRules) if ((r.source ?? "metrics") === "metrics") out.push(r);
  for (const s of input.services) {
    for (const r of s.probeRules ?? []) if ((r.source ?? "metrics") === "metrics") out.push(r);
  }
  return out;
}

/** Collect every logs-source rule. Discovery only writes these per-service. */
function allLogRules(input: DiscoverInput): ProbeMetricRule[] {
  const out: ProbeMetricRule[] = [];
  for (const r of input.globalProbeRules) if (r.source === "logs") out.push(r);
  for (const s of input.services) {
    for (const r of s.probeRules ?? []) if (r.source === "logs") out.push(r);
  }
  return out;
}

export function scorePromQLParses(input: DiscoverInput): DimensionScore {
  const rules = allMetricRules(input);
  if (rules.length === 0) {
    // No metric rules to grade. Don't penalize — globalsPresent/perServicePresent
    // already captured the "nothing to evaluate" case.
    return { name: "promql_parses", score: 25, max: 25, notes: ["no metric rules (nothing to grade)"] };
  }
  const failures: string[] = [];
  for (const r of rules) {
    const check = parsesAsPromQL(r.query);
    if (!check.ok) failures.push(`${r.name}: ${check.reason}`);
  }
  const score = failures.length === 0
    ? 25
    : Math.max(0, Math.round(25 * (1 - failures.length / rules.length)));
  return {
    name: "promql_parses",
    score,
    max: 25,
    notes: failures.length === 0 ? [`${rules.length} rule(s) parse`] : failures.slice(0, 5),
  };
}

export function scoreLogQLParses(input: DiscoverInput): DimensionScore {
  const rules = allLogRules(input);
  if (rules.length === 0) {
    return { name: "logql_parses", score: 25, max: 25, notes: ["no log rules (nothing to grade)"] };
  }
  const failures: string[] = [];
  for (const r of rules) {
    const check = parsesAsLogQL(r.query);
    if (!check.ok) failures.push(`${r.name}: ${check.reason}`);
  }
  const score = failures.length === 0
    ? 25
    : Math.max(0, Math.round(25 * (1 - failures.length / rules.length)));
  return {
    name: "logql_parses",
    score,
    max: 25,
    notes: failures.length === 0 ? [`${rules.length} rule(s) parse`] : failures.slice(0, 5),
  };
}

// ── Top-level eval ───────────────────────────────────────────────────────────

export function evalDiscoverOutput(input: DiscoverInput): EvalResult {
  const dims = [
    scoreGlobalsPresent(input),
    scorePerServicePresent(input),
    scorePromQLParses(input),
    scoreLogQLParses(input),
  ];
  const total = dims.reduce((sum, d) => sum + d.score, 0);
  const summary = [
    `Total: ${total}/100`,
    "",
    ...dims.map((d) => `  ${d.name.padEnd(22)} ${d.score.toString().padStart(2)}/25  — ${d.notes.join("; ")}`),
  ].join("\n");
  return { total, dimensions: dims, summary };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface CliArgs {
  inputPath: string;
  fixture: boolean;
  minScore: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { inputPath: "services.yaml", fixture: false, minScore: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) { args.inputPath = argv[++i]!; continue; }
    if (a === "--fixture") { args.fixture = true; continue; }
    if (a === "--min-score" && argv[i + 1]) { args.minScore = parseInt(argv[++i]!, 10); continue; }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.inputPath);
  console.log(`discover-eval: scoring ${path}`);
  const input = loadInput(path, args.fixture);
  console.log(`  services: ${input.services.length}, globalProbeRules: ${input.globalProbeRules.length}`);
  console.log("");
  const result = evalDiscoverOutput(input);
  console.log(result.summary);
  if (args.minScore !== null && result.total < args.minScore) {
    console.log(`\nFAIL: score ${result.total} < min-score ${args.minScore}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

// ESM-safe "am I the entrypoint" check.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();

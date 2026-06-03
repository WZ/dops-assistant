/**
 * Orchestrator increment 2 — the real LLM decide-fn + headless runner.
 *
 * `createLlmDecideMove` is the agent's brain: given the orchestrator's
 * read-only state, an LLM picks the next move. It follows the project's
 * structured-output convention (generateText + JSON parse, NO tools / NO
 * responseFormat — which sidesteps the gpt-oss `<|constrain|>json` quirk; see
 * CLAUDE.md) and is robust to messy output (fenced / prose-wrapped JSON, schema
 * drift → graceful null rather than a throw).
 *
 * `runAutonomousOrchestrator` wires the three injected deps of the pure core
 * (orchestrator.ts) to their real implementations: decideMove → this LLM,
 * gatherEvidence → createGatherEvidence (read-only by construction), evaluate →
 * the evaluatePrediction keystone. Token usage from both the decide calls and
 * the evidence queries feeds the budget guard.
 */
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import {
  runOrchestrator,
  type OrchestratorMove,
  type OrchestratorState,
  type OrchestratorGuards,
  type OrchestratorResult,
  type TraceEntry,
} from "./orchestrator.js";
import { HypothesisPredictionSchema } from "../workflows/schemas.js";
import { createGatherEvidence } from "../workflows/steps/hypothesis-requery.js";
import { evaluatePrediction, type CorroborationContext, type HypothesisPrediction, type NormalizedObservation } from "../workflows/steps/corroboration.js";
import { withLlmRetry, type LlmRetryConfig } from "./shared/llm-retry.js";
import { LlmUnavailableError } from "./shared/llm-errors.js";
import type { MastraProvider } from "../mcp/provider.js";

/** The move shape the LLM emits (`move` discriminant), validated before mapping
 *  to the core's `OrchestratorMove` (`type` discriminant). `done` → null. */
const LlmMoveSchema = z.discriminatedUnion("move", [
  z.object({ move: z.literal("hypothesize"), hypothesis: z.string().min(1), prediction: HypothesisPredictionSchema }),
  z.object({ move: z.literal("query"), target: z.number().int().nonnegative() }),
  z.object({ move: z.literal("test"), target: z.number().int().nonnegative() }),
  z.object({
    move: z.literal("conclude"),
    leading: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1).default(0.5),
    rationale: z.string().default(""),
  }),
  z.object({ move: z.literal("spawn-subagent"), service: z.string().min(1), question: z.string().min(1) }),
  z.object({ move: z.literal("follow-cause"), service: z.string().min(1) }),
  z.object({ move: z.literal("done") }),
]);

/** Pull the first balanced JSON object out of an LLM response (tolerates code
 *  fences and surrounding prose). Returns the raw substring, or null. */
function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  // Strip ```json ... ``` fences if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf("{");
  if (start === -1) return null;
  // Walk to the matching closing brace (string-aware) so trailing prose is ignored.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse an LLM response into an OrchestratorMove. Returns null for an explicit
 * `done`, or for any unparseable / schema-invalid output (the caller treats
 * null as "no move" → the loop exhausts gracefully rather than crashing).
 */
export function parseMove(text: string): OrchestratorMove | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = LlmMoveSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  switch (m.move) {
    case "hypothesize":
      return { type: "hypothesize", hypothesis: { hypothesis: m.hypothesis, prediction: m.prediction } };
    case "query":
      return { type: "query", target: m.target };
    case "test":
      return { type: "test", target: m.target };
    case "conclude":
      return { type: "conclude", leading: m.leading, confidence: m.confidence, rationale: m.rationale };
    case "spawn-subagent":
      return { type: "spawn-subagent", service: m.service, question: m.question };
    case "follow-cause":
      return { type: "follow-cause", service: m.service };
    case "done":
      return null;
  }
}

const SYSTEM_PROMPT = `You are an autonomous incident investigator. Each turn you choose ONE next move to find the ROOT CAUSE of an incident using read-only evidence. Reason briefly, then emit your move.

Moves — emit EXACTLY ONE as a single JSON object (no prose, no code fence):
- {"move":"hypothesize","hypothesis":"<one-line candidate cause>","prediction":<PREDICTION>}
    add a candidate cause with a CHECKABLE prediction. PREDICTION is one of:
      {"kind":"metric-threshold","metric":"<name>","op":">"|"<"|">="|"<=","value":<number>}
      {"kind":"log-pattern","pattern":"<substring>","present":true|false}
      {"kind":"infra-status","resource":"<name>","status":"<e.g. OOMKilled|FailedScheduling>"}
      {"kind":"change-in-window","withinMinutesBefore":<number>}
- {"move":"query","target":<hypothesis index>}   gather read-only evidence for that hypothesis's prediction.
- {"move":"test","target":<hypothesis index>}     score that hypothesis against gathered evidence.
- {"move":"conclude","leading":<index>,"confidence":<0..1>,"rationale":"<why>"}
    propose the leading hypothesis as the root cause.
- {"move":"spawn-subagent","service":"<service>","question":"<focused question>"}
    run a scoped sub-investigation on a RELATED service and fold its findings
    into the evidence.
- {"move":"follow-cause","service":"<dependency>"}
    follow the incident into one of the listed dependency services (a scoped
    sub-investigation there). Only valid for services in the dependencies list.
- {"move":"done"}   nothing left to try.

Rules:
- A "conclude" ONLY ends the investigation if that hypothesis was already TESTED and its evidence came back satisfied. Confidence alone never ends it. So: hypothesize → query → test BEFORE you conclude.
- If a test fails (contradicted/absent), hypothesize a different cause; don't keep retesting the same one.
- IMPORTANT: after just ONE or TWO local hypotheses fail AND a dependencies list is shown, follow-cause into a dependency instead of trying more local guesses — the fault is often in a connected service. Don't burn all your strikes locally.
- After a follow-cause or subagent returns findings, those findings are your BEST lead. Immediately hypothesize the specific cause they point to (with a checkable prediction) and test it — never stop right after following without turning the finding into a tested hypothesis.
- Be decisive — your budget is limited. Prefer the most likely cause first.
Output ONLY the JSON object for your chosen move.`;

/** Render the read-only state into the per-turn user prompt. */
export function buildStatePrompt(focus: string, state: OrchestratorState, guards: OrchestratorGuards): string {
  const lines: string[] = [];
  lines.push(`Incident under investigation: ${focus}`);
  lines.push("");
  const tokensLeft = Math.max(0, guards.maxTokens - state.tokensSpent);
  const queriesLeft = Math.max(0, guards.maxToolCalls - state.toolCalls);
  lines.push(
    `Budget: ~${tokensLeft} output tokens, ${queriesLeft} queries left; strikes ${state.strikes}/${guards.maxStrikes} (consecutive failed tests).`,
  );
  lines.push("");

  if (state.dependencies.length > 0) {
    lines.push(`Dependencies you can follow-cause into: ${state.dependencies.join(", ")}`);
    lines.push("");
  }

  if (state.hypotheses.length === 0) {
    lines.push("Hypotheses so far: (none — start by hypothesizing the most likely cause)");
  } else {
    lines.push("Hypotheses so far:");
    state.hypotheses.forEach((h, i) => {
      const v = h.lastVerdict ? `, verdict: ${h.lastVerdict}` : ", untested";
      lines.push(`  [${i}] ${h.hypothesis.hypothesis} — standing: ${h.standing}${v}`);
    });
  }
  lines.push("");

  if (state.evidence.length === 0) {
    lines.push("Evidence gathered: (none yet)");
  } else {
    lines.push(`Evidence gathered (${state.evidence.length} observations):`);
    for (const o of state.evidence.slice(-12)) {
      const val = o.value !== undefined ? ` = ${o.value}` : "";
      const txt = o.text ? ` (${o.text.slice(0, 60)})` : "";
      lines.push(`  - ${o.phase} ${o.subject}${val}${txt}`);
    }
  }
  lines.push("");

  const recent = state.trace.slice(-6);
  if (recent.length > 0) {
    lines.push("Recent moves:");
    for (const t of recent) {
      lines.push(`  - ${t.move}: ${t.detail}${t.verdict ? ` [${t.verdict}]` : ""}`);
    }
    lines.push("");
  }

  lines.push("Pick the next move (single JSON object).");
  return lines.join("\n");
}

export interface UsageEvent {
  outputTokens?: number;
  totalTokens?: number;
}

export interface CreateLlmDecideMoveOptions {
  model: LanguageModel;
  /** One-line incident description shown to the agent each turn. */
  focus: string;
  /** Guards, so the prompt can show the agent its remaining budget. */
  guards: OrchestratorGuards;
  llmRetry?: LlmRetryConfig;
  /** Per-call idle timeout (ms); generateText has none of its own. */
  llmCallMs?: number;
  /** Best-effort token accounting sink (feeds the budget guard). */
  onUsage?: (usage: UsageEvent) => void;
  /**
   * Test seam: return the raw model text for (system, prompt). Defaults to the
   * real generateText path. Injected in unit tests so move selection can be
   * verified without a live model.
   */
  callModel?: (system: string, prompt: string) => Promise<string>;
}

/** Build the LLM-backed decide-fn for runOrchestrator. */
export function createLlmDecideMove(
  opts: CreateLlmDecideMoveOptions,
): (state: OrchestratorState) => Promise<OrchestratorMove | null> {
  const retry: LlmRetryConfig = opts.llmRetry ?? { maxAttempts: 1 };
  const call =
    opts.callModel ??
    (async (system: string, prompt: string): Promise<string> => {
      const { text, usage } = await withLlmRetry(() => {
        const abortSignal =
          opts.llmCallMs && opts.llmCallMs > 0 ? AbortSignal.timeout(opts.llmCallMs) : undefined;
        return generateText({ model: opts.model, system, prompt, temperature: 0, abortSignal });
      }, retry);
      if (usage) {
        opts.onUsage?.({
          outputTokens: (usage as { outputTokens?: number }).outputTokens,
          totalTokens: (usage as { totalTokens?: number }).totalTokens,
        });
      }
      return text;
    });

  return async (state) => {
    const prompt = buildStatePrompt(opts.focus, state, opts.guards);
    let text: string;
    try {
      text = await call(SYSTEM_PROMPT, prompt);
    } catch (err) {
      // LLM truly unavailable → propagate so the runner can fail cleanly.
      // Any other error degrades to "no move" so a single bad turn doesn't crash.
      if (err instanceof LlmUnavailableError) throw err;
      return null;
    }
    return parseMove(text);
  };
}

export interface RunAutonomousOrchestratorOptions {
  /** One-line incident description (e.g. "checkout-api 5xx spike at 13:58"). */
  focus: string;
  model: LanguageModel;
  providers: MastraProvider[];
  guards: OrchestratorGuards;
  timeRange?: { from: string; to: string };
  ctx?: CorroborationContext;
  llmRetry?: LlmRetryConfig;
  llmCallMs?: number;
  onStep?: (entry: TraceEntry) => void;
  /** Depth-1 subagent dispatch (scoped sub-investigation → observations). Wired
   *  by the orchestrate adapter; absent → spawn-subagent gracefully skips. */
  spawnSubagent?: (args: { service: string; question: string }) => Promise<NormalizedObservation[]>;
  /** Dependency-graph neighbors of the incident service the agent may
   *  follow-cause into. Empty → follow-cause disabled. */
  dependencies?: string[];
  /** Interactive strike-limit hook (increment 5). Absent → the strike limit
   *  stops directly. Wired by the orchestrate adapter to the WS pause card. */
  onOperatorPause?: (state: OrchestratorState) => Promise<"continue" | "escalate" | "wait">;
}

/**
 * Headless entry point: wire the LLM decide-fn + read-only evidence gather +
 * keystone into the pure orchestrator loop and run it. Token usage from decide
 * calls and evidence queries both feed the budget guard.
 */
export async function runAutonomousOrchestrator(
  opts: RunAutonomousOrchestratorOptions,
): Promise<OrchestratorResult> {
  let pendingTokens = 0;
  const addTokens = (u: UsageEvent): void => {
    pendingTokens += u.outputTokens ?? u.totalTokens ?? 0;
  };

  const gather = createGatherEvidence({
    providers: opts.providers,
    model: opts.model,
    timeRange: opts.timeRange,
    useQuirkHandling: true,
    llmRetry: opts.llmRetry,
    ctx: opts.ctx,
    onTokenUsage: (u: { outputTokens?: number; totalTokens?: number }) => addTokens(u),
  });

  const decideMove = createLlmDecideMove({
    model: opts.model,
    focus: opts.focus,
    guards: opts.guards,
    llmRetry: opts.llmRetry,
    llmCallMs: opts.llmCallMs,
    onUsage: addTokens,
  });

  return runOrchestrator({
    decideMove,
    // The core's RankedHypothesis carries prediction as Record<string,unknown>
    // (rca-types), but every prediction in play was validated against
    // HypothesisPredictionSchema when the LLM emitted the hypothesize move, so
    // it is a real HypothesisPrediction at runtime. Coerce at this boundary.
    gatherEvidence: (h) => gather({ hypothesis: h.hypothesis, prediction: h.prediction as HypothesisPrediction }, 1),
    evaluate: (prediction: HypothesisPrediction, evidence) => evaluatePrediction(prediction, evidence, opts.ctx ?? {}),
    spawnSubagent: opts.spawnSubagent,
    dependencies: opts.dependencies,
    onOperatorPause: opts.onOperatorPause,
    guards: opts.guards,
    onStep: opts.onStep,
    // Drain tokens accrued (decide + query) since the previous move.
    estimateTokens: () => {
      const t = pendingTokens;
      pendingTokens = 0;
      return t;
    },
  });
}

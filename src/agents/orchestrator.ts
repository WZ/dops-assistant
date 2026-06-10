/**
 * Autonomous investigation orchestrator (Approach D) — core control loop.
 *
 * This is the move-loop + safety harness + hybrid stop signal. It is a NEW
 * agent that WRAPS the fixed investigation DAG (it does not replace it):
 * `spawn-subagent` runs `runInvestigation` scoped to a sub-question, and the
 * Step-2 corroboration keystone (`evaluatePrediction`) is the stop gate.
 *
 * Increment 1 (this file): pure, fully-injected control flow so it is
 * unit-testable without an LLM or MCP. Moves implemented: hypothesize, query,
 * test, conclude. `spawn-subagent` / `follow-cause` are recognized but deferred
 * to later increments (they no-op with a trace entry). The real LLM decide-fn,
 * evidence gather, and keystone are wired in a later increment via OrchestratorDeps.
 *
 * DECISION 1 (hybrid stop) — the crux: the agent may PROPOSE `conclude`, but the
 * loop only actually stops on a `conclude` when the leading hypothesis is
 * DETERMINISTICALLY confirmed by the keystone (its latest verdict is
 * "satisfied"). The LLM's self-reported confidence is recorded but is NEVER the
 * gate. Self-confidence can DIRECT the search; it can never END it. The only
 * other ways the loop ends are guard trips (Decision 2).
 *
 * DECISION 2 (safety harness): budget (tokens), depth (subagent nesting),
 * strikes (consecutive rule-outs → operator pause), tool-cap, wall-clock. All
 * hard limits, all config-tunable. Strikes hitting the limit is a first-class
 * `operator-pause` outcome, not a silent stop.
 */
import type { RankedHypothesis } from "../types/rca-types.js";
import type {
  NormalizedObservation,
  HypothesisPrediction,
  Verdict,
} from "../workflows/steps/corroboration.js";

/** The moves the orchestrator LLM can pick at each step. */
export type OrchestratorMove =
  /** Add a candidate root cause (with a structured, checkable prediction). */
  | { type: "hypothesize"; hypothesis: RankedHypothesis }
  /** Gather read-only evidence for hypotheses[target]'s prediction. */
  | { type: "query"; target: number }
  /** Score hypotheses[target] against gathered evidence via the keystone. */
  | { type: "test"; target: number }
  /** Propose done. Gated — see DECISION 1. `confidence` is advisory only. */
  | { type: "conclude"; leading: number; confidence: number; rationale: string }
  /** Scoped sub-investigation on a service (increment 3 — deferred). */
  | { type: "spawn-subagent"; service: string; question: string }
  /** Follow the cause into a dependent service (increment 4 — deferred). */
  | { type: "follow-cause"; service: string };

/** A hypothesis's standing. `inconclusive` = tested but no evidence was gathered
 *  either way (the keystone returned `absent`) — distinct from `ruled-out`, which
 *  means evidence actively CONTRADICTED it. Absence of evidence is not refutation:
 *  an `inconclusive` cause may still be the real one (the data source was just
 *  unavailable), so it's never reported as "ruled out". */
export type HypothesisStanding = "open" | "confirmed" | "ruled-out" | "inconclusive";

export interface TrackedHypothesis {
  hypothesis: RankedHypothesis;
  standing: HypothesisStanding;
  /** Most recent deterministic keystone verdict, if tested. */
  lastVerdict?: Verdict;
}

export interface TraceEntry {
  // The move types, plus "decide" — a non-move trace entry recorded when the
  // decide-move watchdog trips (a starved/hung brain), so the stall is visible in
  // the stream instead of a silent gap.
  move: OrchestratorMove["type"] | "decide";
  detail: string;
  verdict?: Verdict;
}

/** Read-only view handed to the decide-fn each step. */
export interface OrchestratorState {
  readonly hypotheses: ReadonlyArray<TrackedHypothesis>;
  readonly evidence: ReadonlyArray<NormalizedObservation>;
  /** The incident service's dependency-graph neighbors — the only services the
   *  agent may follow-cause into. Empty when no dependency data is available. */
  readonly dependencies: ReadonlyArray<string>;
  readonly depth: number;
  /** Subagents (scoped sub-investigations) spawned so far. */
  readonly subagents: number;
  /** Consecutive ruled-out tests since the last confirmation. */
  readonly strikes: number;
  readonly tokensSpent: number;
  readonly toolCalls: number;
  readonly elapsedMs: number;
  readonly trace: ReadonlyArray<TraceEntry>;
  /** PR-4: the operator's free-text lead from a continue-with-context resume,
   *  standing until the run ends or a later pause replaces it. Rendered into the
   *  decide-move prompt as human guidance. Absent until the operator steers. */
  readonly operatorContext?: string;
  /** Services the agent has actually followed-cause / spawned into so far. Used by
   *  the per-turn prompt's follow-through nudge (inc-7 #4): once a dependency has
   *  been followed, the agent must turn its findings into a tested hypothesis NAMING
   *  that service before concluding — never confirm a shallow local cause on top of
   *  an un-pursued follow. Absent on legacy callers → no nudge. */
  readonly followedServices?: ReadonlyArray<string>;
}

export type OrchestratorOutcome =
  | "confirmed" // hybrid stop: leading hypothesis deterministically satisfied
  | "operator-pause" // strikes limit → hand back to a human
  | "budget-exhausted"
  | "tool-cap"
  | "wall-clock"
  | "exhausted" // decide-fn signalled no further moves
  | "inconclusive" // stalled (no progress) or hit the move backstop
  | "aborted"; // caller aborted (e.g. the operator disconnected)

export interface OrchestratorGuards {
  /** Output-token budget. */
  maxTokens: number;
  /** Subagent / follow-cause nesting depth (for future recursion; v1 subagents are depth-1). */
  maxDepth: number;
  /** Max scoped sub-investigations (depth-1) the orchestrator may spawn. */
  maxSubagents: number;
  /** Consecutive rule-outs before pausing for an operator. */
  maxStrikes: number;
  /** Total read-only queries. */
  maxToolCalls: number;
  /** Wall-clock budget in ms. */
  wallClockMs: number;
  /**
   * Per-operation watchdog (ms): a single evidence gather or subagent run that
   * exceeds this is abandoned (treated as no findings) so one hung MCP/LLM call
   * can't strand the whole loop between guard checks. Absent / ≤0 → no per-op
   * bound (the wall-clock guard is the only backstop).
   */
  opTimeoutMs?: number;
}

export interface OrchestratorDeps {
  /**
   * The agent's brain: pick the next move from the current state. In prod this
   * is an LLM; in tests it's a scripted sequence. Return `null` to signal "no
   * further moves" (→ `exhausted`).
   */
  decideMove: (state: OrchestratorState) => Promise<OrchestratorMove | null>;
  /** Read-only evidence gather for a hypothesis's prediction (createGatherEvidence in prod). */
  gatherEvidence: (hypothesis: RankedHypothesis) => Promise<NormalizedObservation[]>;
  /** Deterministic keystone (evaluatePrediction in prod). */
  evaluate: (prediction: HypothesisPrediction, evidence: NormalizedObservation[]) => Verdict;
  /**
   * Run a scoped sub-investigation (depth-1) on a service and fold its findings
   * back as observations. In prod this dispatches runInvestigation; absent in
   * tests / when subagents aren't wired (then spawn-subagent gracefully skips).
   */
  spawnSubagent?: (args: { service: string; question: string }) => Promise<NormalizedObservation[]>;
  /** The incident service's dependency neighbors the agent may follow-cause into
   *  (resolved from the dependency graph). Empty → follow-cause is disabled. */
  dependencies?: string[];
  /** The incident service itself. Used by the cross-service confirm guard so a
   *  cause about the incident service's own behavior isn't treated as needing a
   *  follow-cause. Mentions of OTHER (dependency) services do. */
  incidentService?: string;
  /** All known service names (not just dep-graph neighbors). The cross-service
   *  confirm guard checks against these too, so a false-confirm that blames
   *  another service is caught even when the dependency graph is empty/missing
   *  (inc-7 #3 — the keystone can be independently true but not causally linked). */
  knownServices?: string[];
  /**
   * Strikes-limit hook: instead of silently stopping at the strike limit, ask a
   * human. "continue" resets the strike counter and resumes the loop (the other
   * guards still bound it); "escalate"/"wait" stop with that disposition. Absent
   * → the strike limit stops directly (operator-pause), as before.
   *
   * PR-4: resolves to `{ decision, context? }` — `context` is the operator's
   * optional free-text lead, applied as standing guidance from the next move on.
   * (Inline type, not the registry's PauseResolution, to keep the core pure.)
   */
  onOperatorPause?: (
    state: OrchestratorState,
  ) => Promise<{ decision: "continue" | "escalate" | "wait"; context?: string }>;
  /**
   * Follow a lead: an OPTIONAL operator hunch supplied at launch. Seeds the run's
   * standing guidance (`operatorContext`) from move 1, so `decideMove` opens against
   * the lead instead of a cold hypothesis. Same standing-until-replaced semantics as
   * a pause lead (PR-4) — a later pause lead replaces it. Absent → a blind hunt.
   */
  initialLead?: string;
  guards: OrchestratorGuards;
  /**
   * Abort the run cooperatively (checked at the top of each move). The WS layer
   * wires this to the connection: if the operator disconnects, the loop stops
   * (`aborted`) instead of running on headless with no one watching.
   */
  signal?: AbortSignal;
  /** Injected clock so wall-clock is testable. Defaults to Date.now. */
  now?: () => number;
  /** Output-token estimate per move, for budget accounting. Defaults to 0. */
  estimateTokens?: (move: OrchestratorMove) => number;
  /** Live progress sink (the agent-stream UX wires this). */
  onStep?: (entry: TraceEntry) => void;
  /**
   * Move-boundary hook (PR-2c), awaited at the top of each move after the abort
   * guard. The WS layer uses it to *park* a viewerless run — block here until a
   * client reattaches — bounding headless token burn without aborting the run.
   * Absent → the loop never parks. A parked run is unblocked by a reattach (or by
   * an abort, which resolves the park and trips the abort guard next iteration).
   */
  onMoveBoundary?: () => Promise<void> | void;
}

export interface OrchestratorResult {
  outcome: OrchestratorOutcome;
  /** Set only on `confirmed`. */
  confirmed?: RankedHypothesis;
  hypotheses: TrackedHypothesis[];
  evidence: NormalizedObservation[];
  trace: TraceEntry[];
  stats: {
    moves: number;
    toolCalls: number;
    tokensSpent: number;
    strikes: number;
    depth: number;
    subagents: number;
    elapsedMs: number;
  };
}

/** Case-insensitive whole-token-ish mention of a service name in free text. */
export function mentionsService(text: string, service: string): boolean {
  const needle = service.trim().toLowerCase();
  if (!needle) return false;
  const haystack = text.toLowerCase();
  const isServiceNameChar = (ch: string | undefined): boolean => !!ch && /[a-z0-9._-]/i.test(ch);
  let from = 0;
  while (from < haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = haystack[idx - 1];
    const after = haystack[idx + needle.length];
    if (!isServiceNameChar(before) && !isServiceNameChar(after)) return true;
    from = idx + 1;
  }
  return false;
}

/** Absolute backstop on move count — far above any real run; catches a runaway decide-fn. */
const MAX_MOVES = 1000;
/** Consecutive non-productive moves (no new evidence / hypotheses, rejected conclude) → inconclusive. */
const MAX_STALL = 8;
/**
 * Fast no-evidence bail (inc-7): if this many queries have run and gathered ZERO
 * evidence in total, the service is quiet/idle — there's nothing to find, so bail
 * early instead of burning a full run (the idle-bench run cost 19 moves / 7
 * queries / 16.6k tokens before pausing). Distinct from MAX_STALL, which counts
 * CONSECUTIVE empties; this trips on cumulative emptiness across the whole run.
 */
const NO_EVIDENCE_BAIL_QUERIES = 4;
/**
 * Hard cap on operator "continue" decisions. Each continue resets the strike
 * counter and resumes; without a ceiling, a hung or looping operator prompt
 * (held open by a generous wall-clock) could resume forever. After this many
 * continues the loop stops with `operator-pause` without asking again — the
 * other guards still bound each resumed leg, this just bounds the legs.
 */
export const MAX_OPERATOR_CONTINUES = 3;

/**
 * Bound an async operation by a watchdog timeout. On timeout, resolves to
 * `{ timedOut: true, value: fallback }` (the in-flight promise is abandoned, not
 * cancelled — acceptable for the read-only gather/subagent ops). `ms ≤ 0` /
 * undefined → no bound (await the promise as-is). Rejections propagate.
 */
async function raceOp<T>(op: Promise<T>, ms: number | undefined, fallback: T): Promise<{ timedOut: boolean; value: T }> {
  if (!ms || ms <= 0) return { timedOut: false, value: await op };
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ timedOut: true; value: T }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, value: fallback }), ms);
  });
  try {
    return await Promise.race([op.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Run the orchestrator loop. Pure control flow over injected dependencies:
 * deterministic given a deterministic `decideMove`. Never throws on a bad move
 * (unknown / out-of-range targets are traced and skipped), so a confused LLM
 * degrades to `inconclusive`/`exhausted` rather than crashing.
 */
export async function runOrchestrator(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const now = deps.now ?? Date.now;
  const estimate = deps.estimateTokens ?? (() => 0);
  const start = now();

  const hypotheses: TrackedHypothesis[] = [];
  const evidence: NormalizedObservation[] = [];
  const dependencies = deps.dependencies ?? [];
  // Services the agent actually ran a sub-investigation into (spawn / follow).
  // The cross-service confirm guard requires a service to be in here before a
  // cause implicating it can be confirmed.
  const followedServices = new Set<string>();
  const trace: TraceEntry[] = [];
  let depth = 0;
  let subagents = 0;
  let strikes = 0;
  let tokensSpent = 0;
  let toolCalls = 0;
  let moves = 0;
  let stall = 0;
  let operatorContinues = 0;
  // PR-4: the operator's standing lead from a continue-with-context resume. Set
  // when a pause resolves with one, kept across moves until a later pause replaces
  // it (D1 standing-until-replaced). Rendered into each decide-move prompt.
  // Follow a lead: seeded here from the launch-time lead so the run opens against
  // the operator's hunch (a trimmed-empty lead is treated as absent → blind hunt).
  let operatorContext: string | undefined = deps.initialLead?.trim() || undefined;

  const record = (entry: TraceEntry): void => {
    trace.push(entry);
    deps.onStep?.(entry);
  };

  const elapsed = (): number => now() - start;

  const finish = (outcome: OrchestratorOutcome, confirmed?: RankedHypothesis): OrchestratorResult => ({
    outcome,
    confirmed,
    hypotheses,
    evidence,
    trace,
    stats: { moves, toolCalls, tokensSpent, strikes, depth, subagents, elapsedMs: elapsed() },
  });

  while (moves < MAX_MOVES) {
    // Guards are checked BEFORE spending the next move so a tripped limit never
    // does "one more" expensive thing.
    if (deps.signal?.aborted) return finish("aborted");
    // Park boundary (PR-2c): a viewerless run blocks here until a client
    // reattaches, instead of burning the next move headless. Re-check the abort
    // guard after, since a Stop during park resolves the block then aborts.
    if (deps.onMoveBoundary) {
      await deps.onMoveBoundary();
      if (deps.signal?.aborted) return finish("aborted");
    }
    if (tokensSpent >= deps.guards.maxTokens) return finish("budget-exhausted");
    if (toolCalls >= deps.guards.maxToolCalls) return finish("tool-cap");
    if (elapsed() >= deps.guards.wallClockMs) return finish("wall-clock");
    // strikes → operator pause: the design's headline safety feature. The signal
    // is ambiguous (N hypotheses failed, nothing discriminating emerged); rather
    // than guess, hand the call to a human (if wired) — who can resume the run
    // ("continue", resetting strikes) or stop it. Other guards still bound a
    // resumed run, so "continue" can't run away.
    if (strikes >= deps.guards.maxStrikes) {
      // Only consult the operator while there are continues left in the budget;
      // once spent, stop without re-prompting so a stuck operator can't keep the
      // loop alive indefinitely.
      if (deps.onOperatorPause && operatorContinues < MAX_OPERATOR_CONTINUES) {
        const pauseState: OrchestratorState = {
          hypotheses, evidence, dependencies, depth, subagents, strikes, tokensSpent, toolCalls, elapsedMs: elapsed(), trace, operatorContext, followedServices: [...followedServices],
        };
        const { decision, context } = await deps.onOperatorPause(pauseState);
        if (decision === "continue") {
          operatorContinues++;
          strikes = 0;
          // Standing-until-replaced (D1): adopt a new lead if given, else keep the
          // prior one so earlier guidance still informs the resumed investigation.
          operatorContext = context ?? operatorContext;
          continue;
        }
      }
      return finish("operator-pause");
    }
    if (stall >= MAX_STALL) return finish("inconclusive");
    // Fast no-evidence bail: several queries in and nothing surfaced anywhere →
    // the service is quiet. Stop now rather than burning the full run (inc-7 #5).
    if (toolCalls >= NO_EVIDENCE_BAIL_QUERIES && evidence.length === 0) return finish("inconclusive");

    const state: OrchestratorState = {
      hypotheses,
      evidence,
      dependencies,
      depth,
      subagents,
      strikes,
      tokensSpent,
      toolCalls,
      elapsedMs: elapsed(),
      trace,
      operatorContext,
      followedServices: [...followedServices],
    };

    // Watchdog the brain too — not just evidence gathers. Under contention (the
    // health-poller firing many concurrent auto-investigates), the decide-move LLM
    // call can stall for minutes; an unbounded await here was the inc-7 "0 steps in
    // 8 min" silent hang — the wall-clock guard can't fire while we're parked inside
    // the await. A timeout records a visible step and loops back to the guards, so a
    // starved run stops LOUDLY (repeated timeouts → stall → wall-clock) instead of
    // hanging with no output.
    const { timedOut: decideTimedOut, value: move } = await raceOp(deps.decideMove(state), deps.guards.opTimeoutMs, null);
    if (decideTimedOut) {
      record({ move: "decide", detail: "decide-move timed out (starved or hung) — re-checking guards" });
      stall++;
      continue;
    }
    if (move === null) return finish("exhausted");
    moves++;
    tokensSpent += Math.max(0, estimate(move));

    switch (move.type) {
      case "hypothesize": {
        hypotheses.push({ hypothesis: move.hypothesis, standing: "open" });
        record({ move: "hypothesize", detail: move.hypothesis.hypothesis });
        stall = 0;
        break;
      }
      case "query": {
        const h = hypotheses[move.target];
        if (!h) {
          record({ move: "query", detail: `no hypothesis at index ${move.target} — skipped` });
          stall++;
          break;
        }
        const before = evidence.length;
        const { timedOut, value: obs } = await raceOp(deps.gatherEvidence(h.hypothesis), deps.guards.opTimeoutMs, []);
        evidence.push(...obs);
        toolCalls++;
        record({
          move: "query",
          detail: timedOut
            ? `${h.hypothesis.hypothesis} → timed out (no observations)`
            : `${h.hypothesis.hypothesis} → +${obs.length} observations`,
        });
        stall = evidence.length > before ? 0 : stall + 1;
        break;
      }
      case "test": {
        const h = hypotheses[move.target];
        if (!h) {
          record({ move: "test", detail: `no hypothesis at index ${move.target} — skipped` });
          stall++;
          break;
        }
        const verdict = deps.evaluate(h.hypothesis.prediction as HypothesisPrediction, evidence);
        h.lastVerdict = verdict;
        if (verdict === "satisfied") {
          h.standing = "confirmed";
          strikes = 0;
        } else if (verdict === "contradicted") {
          // Evidence actively refutes it → genuinely ruled out.
          h.standing = "ruled-out";
          strikes++;
        } else {
          // `absent`: no evidence either way (e.g. the data source was
          // unreachable, or nothing matched the prediction). Absence of evidence
          // is NOT refutation — keep it as a live-but-unverified candidate, never
          // "ruled out". Still counts a strike so the loop is bounded.
          h.standing = "inconclusive";
          strikes++;
        }
        record({ move: "test", detail: h.hypothesis.hypothesis, verdict });
        stall = 0;
        break;
      }
      case "conclude": {
        const lead = hypotheses[move.leading];
        // HYBRID STOP: stop only on deterministic confirmation. Self-reported
        // confidence is recorded for the trace but is never the gate.
        if (lead && lead.standing === "confirmed" && lead.lastVerdict === "satisfied") {
          // CROSS-SERVICE GUARD: a cause that blames another service the agent
          // never investigated is correlational, not established — observing
          // that a neighbor is unhealthy doesn't prove it caused this incident.
          // Require a follow-cause into that service before naming it the cause.
          // (Mentions of the incident service's own behavior are fine.) Checks
          // dep-graph neighbors AND all known services, so the guard still fires
          // when the dependency graph is empty (inc-7 #3 false-confirm).
          const candidateServices = dependencies.length || (deps.knownServices?.length ?? 0)
            ? [...new Set([...dependencies, ...(deps.knownServices ?? [])])]
            : [];
          const unfollowedDep = candidateServices.find(
            (dep) =>
              dep !== deps.incidentService &&
              !followedServices.has(dep) &&
              mentionsService(lead.hypothesis.hypothesis, dep),
          );
          if (unfollowedDep) {
            record({
              move: "conclude",
              detail: `not confirmed — blames ${unfollowedDep} but never followed-cause into it; investigate it before concluding`,
            });
            stall++;
            break;
          }
          // CONSUL CATEGORY-ERROR GUARD: "not deployed in k8s / no pod / deployment
          // missing" is a TRUE-but-WRONG cause for a bare-metal Consul service — it
          // has no k8s objects by design, so the missing deployment isn't the root
          // cause. If the run gathered any consul_health evidence, the service is
          // Consul-tracked: reject the k8s-absence conclusion and make the agent
          // confirm via the Consul health signal instead. Genuine k8s incidents
          // (e.g. a deleted namespace) gather no consul_health evidence, so this
          // never fires for them.
          const sawConsulEvidence = evidence.some((o) => /consul_health_service_status/i.test(o.subject));
          const claimsK8sAbsence = /\b(not deployed|no k8s pod|no pod exists|deployment (is )?missing|deployment does not exist|not present in (the )?cluster)\b/i.test(lead.hypothesis.hypothesis);
          if (sawConsulEvidence && claimsK8sAbsence) {
            record({
              move: "conclude",
              detail: `not confirmed — "${lead.hypothesis.hypothesis}" claims a missing k8s deployment, but consul_health evidence shows this is a bare-metal Consul service (no k8s object by design). Confirm via its consul_health_service_status signal instead.`,
            });
            stall++;
            break;
          }
          record({ move: "conclude", detail: `confirmed: ${lead.hypothesis.hypothesis}` });
          return finish("confirmed", lead.hypothesis);
        }
        record({
          move: "conclude",
          detail: `rejected — self-confidence ${move.confidence} not backed by the keystone; continuing`,
        });
        stall++;
        break;
      }
      case "spawn-subagent": {
        if (!deps.spawnSubagent) {
          record({ move: "spawn-subagent", detail: `${move.service}: ${move.question} — subagents unavailable` });
          stall++;
          break;
        }
        if (subagents >= deps.guards.maxSubagents) {
          record({ move: "spawn-subagent", detail: `${move.service}: subagent limit (${deps.guards.maxSubagents}) reached — skipped` });
          stall++;
          break;
        }
        subagents++;
        followedServices.add(move.service);
        const before = evidence.length;
        // Depth-1 scoped sub-investigation; its findings fold back as evidence
        // the orchestrator's subsequent test moves can score against. Watchdog-
        // bounded so a hung sub-investigation can't strand the loop.
        const { timedOut, value: findings } = await raceOp(
          deps.spawnSubagent({ service: move.service, question: move.question }),
          deps.guards.opTimeoutMs,
          [],
        );
        evidence.push(...findings);
        record({
          move: "spawn-subagent",
          detail: timedOut
            ? `${move.service}: ${move.question} → timed out (no findings)`
            : `${move.service}: ${move.question} → +${findings.length} findings`,
        });
        stall = evidence.length > before ? 0 : stall + 1;
        break;
      }
      case "follow-cause": {
        // Follow the incident into a dependency: a scoped sub-investigation on a
        // neighbor from the dependency graph. Reuses the subagent machinery +
        // budget, but is grounded — the target MUST be a known dependency, so
        // the agent can't wander to arbitrary services.
        if (!deps.spawnSubagent || dependencies.length === 0) {
          record({
            move: "follow-cause",
            detail:
              dependencies.length === 0
                ? `${move.service} — no dependency graph available for this incident`
                : `${move.service} — subagents unavailable`,
          });
          stall++;
          break;
        }
        if (!dependencies.includes(move.service)) {
          record({ move: "follow-cause", detail: `${move.service} is not a known dependency — skipped` });
          stall++;
          break;
        }
        if (subagents >= deps.guards.maxSubagents) {
          record({ move: "follow-cause", detail: `${move.service}: subagent limit (${deps.guards.maxSubagents}) reached — skipped` });
          stall++;
          break;
        }
        subagents++;
        followedServices.add(move.service);
        const followedBefore = evidence.length;
        const { timedOut, value: followFindings } = await raceOp(
          deps.spawnSubagent({
            service: move.service,
            question: `Following the dependency from the incident service: is ${move.service} the cause?`,
          }),
          deps.guards.opTimeoutMs,
          [],
        );
        evidence.push(...followFindings);
        record({
          move: "follow-cause",
          detail: timedOut
            ? `${move.service} → timed out (no findings)`
            : `${move.service} → +${followFindings.length} findings`,
        });
        stall = evidence.length > followedBefore ? 0 : stall + 1;
        break;
      }
    }
  }

  return finish("inconclusive");
}

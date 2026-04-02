/**
 * InvestigationRunner — standalone investigation executor with pluggable callbacks.
 *
 * Decouples investigation execution from delivery mechanism:
 *   - WS handler provides callbacks that stream to WebSocket clients
 *   - Headless mode (alert webhook) provides callbacks that only log
 *   - Both paths share the same DB persistence handled by the runner
 *
 * Pipeline:
 *   create DB record → search skills → run investigation agent → track phases
 *   → accumulate tokens → persist report to DB → emit completion
 */

import { ulid } from "ulid";
import pino from "pino";
import type { Database } from "./db.js";
import type { IInvestigationAgent } from "../types/agent-interfaces.js";
import type { RcaReport } from "../types/rca-types.js";
import type { ServiceConfig, InvestigationTemplate } from "../config/schema.js";
import type { SkillStore } from "../skills/store.js";
import type { PhaseStats, ServerMessage } from "../types/ws-types.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

// ── Callback interface ──────────────────────────────────────────────────────

export interface InvestigationCallbacks {
  /** Called when a phase starts or completes */
  onPhase?(phase: string, status: "running" | "complete", stats?: PhaseStats): void;
  /** Called on each tool invocation (calling, success, error) */
  onToolCall?(phase: string, tool: string, args: Record<string, unknown>, status: string, result?: string, durationMs?: number): void;
  /** Called on each agent iteration within a phase */
  onIteration?(phase: string, iteration: number, maxIterations: number, description: string): void;
  /** Called with token usage for a completed phase */
  onPhaseUsage?(investigationId: string, phase: string, inputTokens: number, outputTokens: number, durationMs: number): void;
  /** Called with total token usage at completion */
  onTotalUsage?(investigationId: string, inputTokens: number, outputTokens: number, durationMs: number): void;
  /** Called when investigation completes successfully */
  onComplete?(investigationId: string, report: RcaReport): void;
  /** Called when investigation fails */
  onFailed?(investigationId: string, error: string): void;
}

// ── Phase mapping ───────────────────────────────────────────────────────────

/**
 * Map backend investigation phase names to frontend-friendly names.
 * Some backend phases map to multiple frontend phases (e.g. parallel evidence).
 */
export function mapBackendPhase(backendPhase: string): string[] {
  switch (backendPhase) {
    case "Detecting anomalies":
      return ["planning"];
    case "Planning investigation":
      return ["planning"];
    case "Analyzing metrics, logs & infrastructure":
      return ["metrics", "logs", "infra", "changes"];
    case "Analyzing metrics":
      return ["metrics"];
    case "Analyzing logs":
      return ["logs"];
    case "Checking infrastructure":
      return ["infra"];
    case "Building event timeline":
      return ["synthesis"];
    case "Synthesizing root cause":
      return ["synthesis"];
    case "Validating report":
      return ["synthesis"];
    default:
      return [];
  }
}

// ── Friendly error mapping ──────────────────────────────────────────────────

/** Map raw LLM errors to user-friendly messages. */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/bad gateway|service unavailable|502|503/i.test(raw))
    return "LLM API is currently unavailable. Please try again later.";
  if (/timeout|timed out|ETIMEDOUT/i.test(raw))
    return "LLM API request timed out. Please try again.";
  if (/rate limit|429/i.test(raw))
    return "LLM API rate limit reached. Please wait and try again.";
  return raw;
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface RunnerDeps {
  db: Database;
  investigationAgent: IInvestigationAgent;
  skillStore?: SkillStore;
  /** Global callback fired after every successful investigation (e.g. Slack notification) */
  globalOnComplete?: (investigationId: string, service: string, report: RcaReport) => void;
}

export interface RunOptions {
  service: ServiceConfig;
  message: string;
  investigationId?: string;
  /** Stack ID for multi-stack data isolation */
  stackId?: string;
  /** Investigation depth: "quick" (metrics only), "standard" (metrics+logs), "full" (all phases) */
  template?: InvestigationTemplate;
  /** When true, restrict MCP tool access to read-only tools.
   *  Used by headless investigations (webhook/poller) to prevent write operations. */
  readOnlyTools?: boolean;
  callbacks?: InvestigationCallbacks;
}

export class InvestigationRunner {
  private db: Database;
  private investigationAgent: IInvestigationAgent;
  private skillStore?: SkillStore;
  private globalOnComplete?: (investigationId: string, service: string, report: RcaReport) => void;

  constructor(deps: RunnerDeps) {
    this.db = deps.db;
    this.investigationAgent = deps.investigationAgent;
    this.skillStore = deps.skillStore;
    this.globalOnComplete = deps.globalOnComplete;
  }

  /**
   * Run a full investigation for the given service.
   *
   * Creates a DB record, searches for matching skills, runs the investigation
   * agent with phase/tool/token tracking, persists results, and emits callbacks.
   */
  async run(opts: RunOptions): Promise<RcaReport> {
    const { service, message, callbacks, template, stackId, readOnlyTools } = opts;
    const invId = opts.investigationId ?? `inv_${ulid()}`;

    // 1. Create DB record
    this.db.createInvestigation(stackId ?? "", { id: invId, service: service.name, query: message, status: "running" });

    // 2. Search for matching skills
    let skillContext: string | undefined;
    if (this.skillStore) {
      const matchedSkills = this.skillStore.search({ service: service.name, query: message });
      if (matchedSkills.length > 0) {
        skillContext = this.skillStore.formatForPrompt(matchedSkills);
        logger.debug({ skillCount: matchedSkills.length, skills: matchedSkills.map(s => s.id) }, "Injecting skills into investigation");
      }
    }

    // 3. Set up phase tracking
    const runningPhases = new Set<string>();
    const phaseStats = new Map<string, { toolCalls: number; iterations: number; startMs: number }>();
    const totalTokens = { inputTokens: 0, outputTokens: 0 };
    const phaseTokens = { inputTokens: 0, outputTokens: 0 };
    const investigationStartMs = Date.now();

    // Helper: emit + persist event to DB
    const persistEvent = (eventType: string, payload: Record<string, unknown>) => {
      this.db.createEvent({ id: `evt_${ulid()}`, investigationId: invId, eventType, payload: JSON.stringify(payload) });
    };

    const onTokenUsage = (u: { inputTokens: number; outputTokens: number }) => {
      totalTokens.inputTokens += u.inputTokens;
      totalTokens.outputTokens += u.outputTokens;
      phaseTokens.inputTokens += u.inputTokens;
      phaseTokens.outputTokens += u.outputTokens;
    };

    try {
      // 4. Run investigation with wired callbacks
      const report = await this.investigationAgent.investigate(
        service, undefined, invId, onTokenUsage, message,
        // onToolCall
        (name, args, result, durationMs, error, phase) => {
          const activePhase = phase ?? (runningPhases.size > 0 ? [...runningPhases][0]! : "planning");
          const stats = phaseStats.get(activePhase);
          if (stats && (result !== undefined || error !== undefined)) stats.toolCalls++;

          const status = error ? "error" : result !== undefined ? "success" : "calling";
          callbacks?.onToolCall?.(activePhase, name, args, status, error ?? result, durationMs);
          persistEvent("investigation:tool_call", { phase: activePhase, tool: name, args, status, result: error ?? result, durationMs });
        },
        // onPhase
        (backendPhase) => {
          const frontendPhases = mapBackendPhase(backendPhase);

          // Complete phases that are no longer active
          for (const prev of runningPhases) {
            if (!frontendPhases.includes(prev)) {
              const stats = phaseStats.get(prev);
              const durationMs = stats ? Date.now() - stats.startMs : 0;
              callbacks?.onPhase?.(prev, "complete", stats ? {
                observationCount: 0, criticalCount: 0,
                toolCalls: stats.toolCalls, iterations: stats.iterations, durationMs,
              } : undefined);
              persistEvent("investigation:phase", { phase: prev, status: "complete" });
              callbacks?.onPhaseUsage?.(invId, prev, phaseTokens.inputTokens, phaseTokens.outputTokens, durationMs);
              phaseTokens.inputTokens = 0;
              phaseTokens.outputTokens = 0;
              runningPhases.delete(prev);
            }
          }

          // Start new phases
          for (const fp of frontendPhases) {
            if (!runningPhases.has(fp)) {
              callbacks?.onPhase?.(fp, "running");
              persistEvent("investigation:phase", { phase: fp, status: "running" });
              runningPhases.add(fp);
              phaseStats.set(fp, { toolCalls: 0, iterations: 0, startMs: Date.now() });
            }
          }
        },
        // onIteration
        (phase, iteration, maxIterations, description) => {
          const frontendPhase = runningPhases.has(phase) ? phase : (runningPhases.size > 0 ? [...runningPhases][0]! : phase);
          const stats = phaseStats.get(frontendPhase);
          if (stats) stats.iterations = Math.max(stats.iterations, iteration + 1);
          callbacks?.onIteration?.(frontendPhase, iteration, maxIterations, description);
          persistEvent("investigation:iteration", { phase: frontendPhase, iteration, maxIterations, description });
        },
        skillContext,
        template,
        readOnlyTools,
      );

      // 5. Complete remaining phases
      for (const fp of runningPhases) {
        const stats = phaseStats.get(fp);
        const durationMs = stats ? Date.now() - stats.startMs : 0;
        callbacks?.onPhase?.(fp, "complete", stats ? {
          observationCount: 0, criticalCount: 0,
          toolCalls: stats.toolCalls, iterations: stats.iterations, durationMs,
        } : undefined);
        callbacks?.onPhaseUsage?.(invId, fp, phaseTokens.inputTokens, phaseTokens.outputTokens, durationMs);
        phaseTokens.inputTokens = 0;
        phaseTokens.outputTokens = 0;
      }
      runningPhases.clear();

      // 5.5 Confidence gate — force low score when rootCause is vague or evidence is missing
      const vagueRootCause = /unable to determine|under investigation/i.test(report.rootCause ?? "");
      const totalEvidence = (report.evidence?.metrics?.length ?? 0) + (report.evidence?.logs?.length ?? 0) + (report.evidence?.infra?.length ?? 0);
      if (totalEvidence === 0) {
        report.confidenceScore = Math.min(report.confidenceScore ?? 1, 0.2);
        logger.info({ invId, service: service.name }, "Confidence gate: no evidence, forcing score to 0.2");
      } else if (vagueRootCause) {
        report.confidenceScore = Math.min(report.confidenceScore ?? 1, 0.3);
        logger.info({ invId, service: service.name }, "Confidence gate: vague rootCause, forcing score to 0.3");
      }

      // 6. Persist report and token usage
      const totalDurationMs = Date.now() - investigationStartMs;
      this.db.updateInvestigation(invId, { status: "complete", report: JSON.stringify(report) });
      this.db.updateInvestigation(invId, {
        total_input_tokens: totalTokens.inputTokens,
        total_output_tokens: totalTokens.outputTokens,
        total_duration_ms: totalDurationMs,
      });

      callbacks?.onTotalUsage?.(invId, totalTokens.inputTokens, totalTokens.outputTokens, totalDurationMs);
      callbacks?.onComplete?.(invId, report);

      // Fire global completion handler (e.g. Slack notifications)
      try {
        this.globalOnComplete?.(invId, service.name, report);
      } catch (globalErr) {
        logger.warn({ err: globalErr, invId }, "Global onComplete handler failed");
      }

      logger.info({ invId, service: service.name, durationMs: totalDurationMs }, "Investigation complete");
      return report;

    } catch (err) {
      logger.error({ err, invId, service: service.name }, "Investigation failed");
      this.db.updateInvestigation(invId, { status: "failed" });
      const errorMsg = friendlyError(err);
      callbacks?.onFailed?.(invId, errorMsg);
      throw err;
    }
  }
}

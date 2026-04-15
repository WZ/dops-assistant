import type { ProcessInputStepArgs, ProcessInputStepResult } from "@mastra/core/processors";
import { createLogger } from "../../logger.js";

const logger = createLogger("prepare-step");

/**
 * The shape of a Mastra prepareStep function.
 * Matches @mastra/core `PrepareStepFunction` (from loop/types) which is not
 * exported via a stable package entry-point, so we define it locally.
 */
export type PrepareStepFn = (
  args: ProcessInputStepArgs,
) => Promise<ProcessInputStepResult | undefined | void> | ProcessInputStepResult | undefined | void;

/**
 * Configuration for the quirk prepareStep hook.
 */
export interface QuirkPrepareStepConfig {
  /**
   * The maximum number of steps the agent loop will run.
   * Used to determine wind-down phase (last 2 steps) and midpoint nudge (60%).
   */
  maxSteps: number;

  /**
   * Optional nudge message to inject at the midpoint step.
   * Defaults to a reminder for the model to start wrapping up.
   */
  nudgeMessage?: string;
}

const DEFAULT_NUDGE_MESSAGE =
  "You are approaching the end of your investigation. Start synthesizing what you have found into a structured answer. Avoid calling more tools unless absolutely necessary.";

const WIND_DOWN_STEPS = 2;
const MIDPOINT_RATIO = 0.65;

/**
 * Factory that returns a Mastra `prepareStep` function handling two model quirks:
 *
 * 1. **Wind-down** (last `WIND_DOWN_STEPS` steps): disables all tools so the model
 *    is forced to produce a final answer rather than issuing more tool calls.
 *
 * 2. **Midpoint nudge** (at ~60% of maxSteps): injects a user message reminding the
 *    model to start wrapping up, preventing it from exhausting all iterations on
 *    exploration without ever producing output.
 *
 * Returns `undefined` for all other steps (no override).
 */
export function createQuirkPrepareStep(config: QuirkPrepareStepConfig): PrepareStepFn {
  const { maxSteps, nudgeMessage = DEFAULT_NUDGE_MESSAGE } = config;
  const midpointStep = Math.floor(maxSteps * MIDPOINT_RATIO);
  const windDownStartStep = maxSteps - WIND_DOWN_STEPS;

  return function quirkPrepareStep(args: ProcessInputStepArgs): ProcessInputStepResult | undefined {
    const step = args.stepNumber; // 0-indexed
    logger.debug({ step, maxSteps, windDownStartStep, argKeys: Object.keys(args) }, "prepareStep");

    // Wind-down phase: disable tools so the model produces a final answer
    if (step >= windDownStartStep) {
      logger.debug({ step }, "wind-down: disabling tools");
      return {
        tools: {},
        activeTools: [],
        toolChoice: "none" as const,
      };
    }

    // Midpoint nudge: inject a reminder message AND keep toolChoice as "auto"
    if (step === midpointStep) {
      logger.debug({ step }, "midpoint nudge");
      return {
        toolChoice: "auto" as const,
        messages: [
          { role: "user" as const, content: nudgeMessage as any, id: `nudge-${step}`, createdAt: new Date() },
        ],
      };
    }

    // Normal iteration — no override
    return undefined;
  };
}

/**
 * llm-settings — effective-config resolver for per-stack LLM reasoning effort.
 *
 * Two sources, in precedence order per agent bucket:
 *   1. db.settings (`llm.reasoningEffort.${stackId}`) — per-stack override JSON
 *      `{ chat?, investigation?, discovery? }`. Set/cleared from the GUI.
 *   2. config.yaml (`config.llm.reasoningEffort`) — admin-supplied defaults:
 *      `{ default?, chat?, investigation?, discovery? }`. Per-bucket wins over
 *      `default`.
 *
 * Returns `undefined` when nothing is set anywhere — callers MUST treat that
 * as "don't send the reasoning_effort param" so model behavior is unchanged.
 */

import type { Config, ReasoningBucket, ReasoningEffort } from "../config/schema.js";
import type { Database } from "./db.js";

export type ReasoningSource = "stack" | "config" | "default";

export interface BucketEffectiveValue {
  effort: ReasoningEffort | undefined;
  /** Where the effective value came from. "default" = config.llm.reasoningEffort.default fallback. */
  source: ReasoningSource | null;
}

export interface StackLlmSettingsView {
  /** Per-bucket effective value the runtime actually uses. */
  effective: Record<ReasoningBucket, BucketEffectiveValue>;
  /** Raw stack overrides — surfaced so the UI can render "stack vs inherit" badges. */
  stack: Partial<Record<ReasoningBucket, ReasoningEffort>>;
  /** Raw config defaults, surfaced so the UI can show what gets inherited. */
  config: {
    default?: ReasoningEffort;
    chat?: ReasoningEffort;
    investigation?: ReasoningEffort;
    discovery?: ReasoningEffort;
  };
}

const BUCKETS: ReasoningBucket[] = ["chat", "investigation", "discovery"];

export function getEffectiveReasoningEffort(
  db: Database,
  config: Config,
  stackId: string,
  bucket: ReasoningBucket,
): ReasoningEffort | undefined {
  const stackOverride = db.getStackReasoningEffort(stackId);
  if (stackOverride[bucket]) return stackOverride[bucket];
  const cfg = config.llm?.reasoningEffort;
  if (cfg?.[bucket]) return cfg[bucket];
  return cfg?.default;
}

export function getStackLlmSettingsView(
  db: Database,
  config: Config,
  stackId: string,
): StackLlmSettingsView {
  const stack = db.getStackReasoningEffort(stackId);
  const cfg = config.llm?.reasoningEffort ?? {};
  const effective: Record<ReasoningBucket, BucketEffectiveValue> = {
    chat: { effort: undefined, source: null },
    investigation: { effort: undefined, source: null },
    discovery: { effort: undefined, source: null },
  };
  for (const bucket of BUCKETS) {
    if (stack[bucket]) {
      effective[bucket] = { effort: stack[bucket], source: "stack" };
    } else if (cfg[bucket]) {
      effective[bucket] = { effort: cfg[bucket], source: "config" };
    } else if (cfg.default) {
      effective[bucket] = { effort: cfg.default, source: "default" };
    }
  }
  return {
    effective,
    stack,
    config: {
      default: cfg.default,
      chat: cfg.chat,
      investigation: cfg.investigation,
      discovery: cfg.discovery,
    },
  };
}

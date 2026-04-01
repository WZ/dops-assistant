/**
 * Shared constants used across multiple modules.
 * A constant belongs here only if it's used in 2+ files.
 * File-local constants stay in their own module.
 */

/** Maximum chars for MCP tool result strings before truncation. */
export const TOOL_RESULT_TRUNCATION_LIMIT = 8_000;

/** Upper bound for in-memory LRU caches. */
export const MAX_CACHE_ENTRIES = 200;

/** Default time range fallback (8 hours in ms) when no time reference is found. */
export const DEFAULT_TIME_RANGE_MS = 8 * 3_600_000;

/** Default maxSteps for investigation agents (metrics, logs, infra, changes). */
export const DEFAULT_AGENT_MAX_STEPS = 10;

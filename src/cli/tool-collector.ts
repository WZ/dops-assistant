import type { ToolCallRecord } from "./types.js";
import type { OnToolCallEnriched } from "../types/agent-interfaces.js";

const MAX_ARGS_SUMMARY = 80;

export function createToolCollector(verbose: boolean) {
  const records: ToolCallRecord[] = [];

  const callback: OnToolCallEnriched = (name, args, result, durationMs, error, phase) => {
    let argsSummary = JSON.stringify(args);
    if (!verbose && argsSummary.length > MAX_ARGS_SUMMARY) {
      argsSummary = argsSummary.slice(0, MAX_ARGS_SUMMARY) + "...";
    }

    const record: ToolCallRecord = { name, argsSummary };
    if (durationMs !== undefined) record.durationMs = durationMs;

    if (verbose) {
      if (result !== undefined) record.result = result;
      if (error !== undefined) record.error = error;
      if (phase !== undefined) record.phase = phase;
    }

    records.push(record);
  };

  return {
    callback,
    getRecords: () => records,
  };
}

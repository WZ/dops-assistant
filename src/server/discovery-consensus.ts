import type { ServiceConfig, ProbeMetricRule } from "../config/schema.js";

export interface AdditionCandidate {
  name: string;
  payload: ServiceConfig;
  globalsSnapshot: ProbeMetricRule[];
}

export interface RemovalCandidate {
  name: string;
  /** True only if the Prometheus corroboration probe returned empty/0 this run. */
  corroborated: boolean;
}

export interface PendingRowSnapshot {
  id: string;
  serviceName: string;
  seenCount: number;
  lastSeenRunId: string;
  qualifiedAt: string | null;
}

export interface ConsensusInput {
  stackId: string;
  thisRunId: string;
  previousSuccessfulRunId: string | null;
  consensusRuns: number;
  consensusRunsForRemovals: number;
  registeredNames: Set<string>;
  dismissedAdditionNames: Set<string>;
  dismissedRemovalNames: Set<string>;
  pendingAdditionRows: PendingRowSnapshot[];
  pendingRemovalRows: PendingRowSnapshot[];
  registryVersion: string;
  additionCandidates: AdditionCandidate[];
  removalCandidates: RemovalCandidate[];
}

export interface AdditionMutations {
  upsertAdditions: AdditionCandidate[];
  resets: { id: string; runId: string }[];
  deletes: string[];
  qualifications: { id: string; registryVersion: string }[];
}

export function computeAdditionMutations(input: ConsensusInput): AdditionMutations {
  const result: AdditionMutations = { upsertAdditions: [], resets: [], deletes: [], qualifications: [] };
  const candidatesByName = new Map(input.additionCandidates.map((c) => [c.name, c]));
  const rowsByName = new Map(input.pendingAdditionRows.map((r) => [r.serviceName, r]));

  for (const cand of input.additionCandidates) {
    if (input.dismissedAdditionNames.has(cand.name)) continue;
    const existing = rowsByName.get(cand.name);
    if (!existing) {
      result.upsertAdditions.push(cand);
      continue;
    }
    const streakIntact =
      input.previousSuccessfulRunId !== null &&
      existing.lastSeenRunId === input.previousSuccessfulRunId;
    if (!streakIntact) {
      result.resets.push({ id: existing.id, runId: input.thisRunId });
      continue;
    }
    result.upsertAdditions.push(cand);
    if (existing.qualifiedAt === null && existing.seenCount + 1 >= input.consensusRuns) {
      result.qualifications.push({ id: existing.id, registryVersion: input.registryVersion });
    }
  }

  for (const row of input.pendingAdditionRows) {
    if (candidatesByName.has(row.serviceName)) continue;
    const recentlySeen =
      input.previousSuccessfulRunId !== null &&
      row.lastSeenRunId === input.previousSuccessfulRunId;
    if (recentlySeen) continue;
    result.deletes.push(row.id);
  }

  return result;
}

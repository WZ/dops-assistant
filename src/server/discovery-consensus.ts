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

export interface RemovalMutations {
  upsertRemovals: { name: string }[];
  resets: { id: string; runId: string }[];
  deletes: string[];
  qualifications: { id: string; registryVersion: string }[];
}

export function computeRemovalMutations(input: ConsensusInput): RemovalMutations {
  const result: RemovalMutations = { upsertRemovals: [], resets: [], deletes: [], qualifications: [] };
  const rowsByName = new Map(input.pendingRemovalRows.map((r) => [r.serviceName, r]));
  const removalCandidateNames = new Set(input.removalCandidates.map((c) => c.name));

  // Recovery: a registered service NOT in this run's removal candidates means
  // it appeared in discovery this run. Drop its removal row if any.
  for (const row of input.pendingRemovalRows) {
    if (input.registeredNames.has(row.serviceName) && !removalCandidateNames.has(row.serviceName)) {
      result.deletes.push(row.id);
    }
  }

  for (const cand of input.removalCandidates) {
    if (!cand.corroborated) continue;
    if (input.dismissedRemovalNames.has(cand.name)) continue;
    const existing = rowsByName.get(cand.name);
    if (!existing) {
      result.upsertRemovals.push({ name: cand.name });
      continue;
    }
    const streakIntact =
      input.previousSuccessfulRunId !== null &&
      existing.lastSeenRunId === input.previousSuccessfulRunId;
    if (!streakIntact) {
      result.resets.push({ id: existing.id, runId: input.thisRunId });
      continue;
    }
    result.upsertRemovals.push({ name: cand.name });
    if (existing.qualifiedAt === null && existing.seenCount + 1 >= input.consensusRunsForRemovals) {
      result.qualifications.push({ id: existing.id, registryVersion: input.registryVersion });
    }
  }

  return result;
}

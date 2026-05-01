import { describe, it, expect } from "vitest";
import {
  computeAdditionMutations,
  computeRemovalMutations,
  type ConsensusInput,
  type AdditionCandidate,
} from "./discovery-consensus.js";

const baseInput: ConsensusInput = {
  stackId: "s",
  thisRunId: "run-3",
  previousSuccessfulRunId: "run-2",
  consensusRuns: 2,
  consensusRunsForRemovals: 3,
  registeredNames: new Set(),
  dismissedAdditionNames: new Set(),
  dismissedRemovalNames: new Set(),
  pendingAdditionRows: [],
  pendingRemovalRows: [],
  registryVersion: "v-current",
  additionCandidates: [],
  removalCandidates: [],
};

const cand = (name: string): AdditionCandidate => ({
  name,
  payload: { name, metrics: [], logLabels: {}, probeRules: [] } as any,
  globalsSnapshot: [],
});

describe("computeAdditionMutations", () => {
  it("first sighting → upsertAddition only (no qualify yet)", () => {
    const out = computeAdditionMutations({ ...baseInput, additionCandidates: [cand("svc-a")] });
    expect(out.upsertAdditions).toHaveLength(1);
    expect(out.upsertAdditions[0]!.name).toBe("svc-a");
    expect(out.qualifications).toHaveLength(0);
  });

  it("second consecutive sighting → upsert + qualify", () => {
    const out = computeAdditionMutations({
      ...baseInput,
      additionCandidates: [cand("svc-a")],
      pendingAdditionRows: [{
        id: "row-1", serviceName: "svc-a", seenCount: 1,
        lastSeenRunId: "run-2", qualifiedAt: null,
      }],
    });
    expect(out.upsertAdditions).toHaveLength(1);
    expect(out.qualifications).toEqual([{ id: "row-1", registryVersion: "v-current" }]);
  });

  it("streak break (last_seen_run_id !== previousSuccessfulRunId) → reset", () => {
    const out = computeAdditionMutations({
      ...baseInput,
      additionCandidates: [cand("svc-a")],
      pendingAdditionRows: [{
        id: "row-1", serviceName: "svc-a", seenCount: 1,
        lastSeenRunId: "run-1", qualifiedAt: null,
      }],
    });
    expect(out.resets).toEqual([{ id: "row-1", runId: "run-3" }]);
    expect(out.qualifications).toHaveLength(0);
  });

  it("orphaned addition (not in this run AND last_seen_run_id !== prev) → delete", () => {
    const out = computeAdditionMutations({
      ...baseInput,
      additionCandidates: [],
      pendingAdditionRows: [{
        id: "row-1", serviceName: "svc-old", seenCount: 1,
        lastSeenRunId: "run-1", qualifiedAt: null,
      }],
    });
    expect(out.deletes).toEqual(["row-1"]);
  });

  it("orphaned-but-recent addition (last_seen_run_id === prev) is left alone", () => {
    const out = computeAdditionMutations({
      ...baseInput,
      additionCandidates: [],
      pendingAdditionRows: [{
        id: "row-1", serviceName: "svc-old", seenCount: 2,
        lastSeenRunId: "run-2", qualifiedAt: "2026-04-30T00:00:00Z",
      }],
    });
    expect(out.deletes).toHaveLength(0);
    expect(out.resets).toHaveLength(0);
  });

  it("dismissed addition → no row written", () => {
    const out = computeAdditionMutations({
      ...baseInput,
      additionCandidates: [cand("svc-a")],
      dismissedAdditionNames: new Set(["svc-a"]),
    });
    expect(out.upsertAdditions).toHaveLength(0);
  });
});

describe("computeRemovalMutations", () => {
  const removalBase = { ...baseInput, registeredNames: new Set(["svc-x", "svc-y"]) };

  it("registered service back in discovered set → delete its removal row (recovery)", () => {
    const out = computeRemovalMutations({
      ...removalBase,
      removalCandidates: [],
      pendingRemovalRows: [{
        id: "rm-1", serviceName: "svc-x", seenCount: 1,
        lastSeenRunId: "run-2", qualifiedAt: null,
      }],
    });
    expect(out.deletes).toContain("rm-1");
  });

  it("removal candidate without corroboration → no upsert, no streak progress", () => {
    const out = computeRemovalMutations({
      ...removalBase,
      removalCandidates: [{ name: "svc-x", corroborated: false }],
    });
    expect(out.upsertRemovals).toHaveLength(0);
  });

  it("first corroborated removal → upsert seen_count=1 (no qualify yet, threshold=3)", () => {
    const out = computeRemovalMutations({
      ...removalBase,
      removalCandidates: [{ name: "svc-x", corroborated: true }],
    });
    expect(out.upsertRemovals).toEqual([{ name: "svc-x" }]);
    expect(out.qualifications).toHaveLength(0);
  });

  it("third consecutive corroborated removal → qualify", () => {
    const out = computeRemovalMutations({
      ...removalBase,
      removalCandidates: [{ name: "svc-x", corroborated: true }],
      pendingRemovalRows: [{
        id: "rm-1", serviceName: "svc-x", seenCount: 2,
        lastSeenRunId: "run-2", qualifiedAt: null,
      }],
    });
    expect(out.qualifications).toEqual([{ id: "rm-1", registryVersion: "v-current" }]);
  });

  it("dismissed removal → no row written even when corroborated", () => {
    const out = computeRemovalMutations({
      ...removalBase,
      removalCandidates: [{ name: "svc-x", corroborated: true }],
      dismissedRemovalNames: new Set(["svc-x"]),
    });
    expect(out.upsertRemovals).toHaveLength(0);
  });
});

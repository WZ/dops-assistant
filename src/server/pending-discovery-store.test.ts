import { describe, it, expect, beforeEach } from "vitest";
import { Database } from "./db.js";
import { PendingDiscoveryStore } from "./pending-discovery-store.js";

let db: Database;
let store: PendingDiscoveryStore;
const STACK = "test-stack";

beforeEach(() => {
  db = new Database(":memory:");
  store = new PendingDiscoveryStore(db.raw());
});

const sampleService = (name = "svc-a") => ({
  name,
  metrics: [{ query: `up{service="${name}"}`, description: "availability" }],
  logLabels: { container: name },
  probeRules: [],
});

describe("PendingDiscoveryStore — additions", () => {
  it("upserts a new addition with seen_count=1", () => {
    const id = store.upsertAddition({
      stackId: STACK, serviceName: "svc-a", payload: sampleService(),
      globalsSnapshot: [], runId: "run-1",
    });
    const row = store.findByStackKindName(STACK, "addition", "svc-a")!;
    expect(row.id).toBe(id);
    expect(row.seenCount).toBe(1);
    expect(row.lastSeenRunId).toBe("run-1");
    expect(row.qualifiedAt).toBeNull();
    expect(JSON.parse(row.payload!).name).toBe("svc-a");
  });

  it("increments seen_count on a second sighting + refreshes payload/globals/run id", () => {
    store.upsertAddition({ stackId: STACK, serviceName: "svc-a", payload: sampleService(), globalsSnapshot: [], runId: "run-1" });
    store.upsertAddition({
      stackId: STACK, serviceName: "svc-a",
      payload: { ...sampleService(), gitlabProject: "ns/svc-a" },
      globalsSnapshot: [{ name: "g", query: "up{}", threshold: { op: "lt", value: 1 }, consecutiveTicks: 3, source: "metrics" }],
      runId: "run-2",
    });
    const row = store.findByStackKindName(STACK, "addition", "svc-a")!;
    expect(row.seenCount).toBe(2);
    expect(row.lastSeenRunId).toBe("run-2");
    expect(JSON.parse(row.payload!).gitlabProject).toBe("ns/svc-a");
    expect(JSON.parse(row.globalsSnapshot!)).toHaveLength(1);
  });

  it("resets seen_count and clears qualified_at when streak breaks", () => {
    const id = store.upsertAddition({ stackId: STACK, serviceName: "svc-a", payload: sampleService(), globalsSnapshot: [], runId: "run-1" });
    store.markQualified(id, "registry-v1");
    store.resetSeenCount(id, "run-9");
    const row = store.findByStackKindName(STACK, "addition", "svc-a")!;
    expect(row.seenCount).toBe(1);
    expect(row.lastSeenRunId).toBe("run-9");
    expect(row.qualifiedAt).toBeNull();
    expect(row.registryVersionAtQualification).toBeNull();
  });

  it("markQualified sets qualified_at + registry version exactly once", () => {
    const id = store.upsertAddition({ stackId: STACK, serviceName: "svc-a", payload: sampleService(), globalsSnapshot: [], runId: "run-1" });
    store.markQualified(id, "registry-v1");
    const before = store.findByStackKindName(STACK, "addition", "svc-a")!.qualifiedAt!;
    store.markQualified(id, "registry-v2");
    const after = store.findByStackKindName(STACK, "addition", "svc-a")!;
    expect(after.qualifiedAt).toBe(before);
    expect(after.registryVersionAtQualification).toBe("registry-v1");
  });
});

describe("PendingDiscoveryStore — removals", () => {
  it("upserts a removal row keyed by (stack, name, 'removal')", () => {
    store.upsertRemoval({ stackId: STACK, serviceName: "svc-x", runId: "run-1" });
    const row = store.findByStackKindName(STACK, "removal", "svc-x")!;
    expect(row.changeKind).toBe("removal");
    expect(row.payload).toBeNull();
  });

  it("deleteByStackKindName lets the engine clear a recovered service", () => {
    store.upsertRemoval({ stackId: STACK, serviceName: "svc-x", runId: "run-1" });
    store.deleteByStackKindName(STACK, "removal", "svc-x");
    expect(store.findByStackKindName(STACK, "removal", "svc-x")).toBeNull();
  });
});

describe("PendingDiscoveryStore — dismissed/restore", () => {
  it("dismiss moves the row from pending to dismissed and is queryable", () => {
    const id = store.upsertAddition({ stackId: STACK, serviceName: "svc-a", payload: sampleService(), globalsSnapshot: [], runId: "run-1" });
    store.dismiss(id);
    expect(store.findById(id)).toBeNull();
    expect(store.isDismissed(STACK, "svc-a", "addition")).toBe(true);
    expect(store.listDismissed(STACK)).toHaveLength(1);
  });

  it("restore deletes the dismissed row so the next tick can re-create a pending one", () => {
    const id = store.upsertAddition({ stackId: STACK, serviceName: "svc-a", payload: sampleService(), globalsSnapshot: [], runId: "run-1" });
    store.dismiss(id);
    const dismissedId = store.listDismissed(STACK)[0]!.id;
    store.restoreDismissed(dismissedId);
    expect(store.isDismissed(STACK, "svc-a", "addition")).toBe(false);
  });
});

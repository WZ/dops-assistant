import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./db.js";

const S = "stack-a";

describe("markStaleInvestigations", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.createInvestigation(S, { id: "inv-fresh", service: "api", query: "q", status: "running" });
    db.createInvestigation(S, { id: "inv-done", service: "api", query: "q", status: "complete" });
  });
  afterEach(() => db.close());

  it("leaves a just-started run alone with the default 10-minute threshold", () => {
    expect(db.markStaleInvestigations()).toBe(0);
    expect(db.getInvestigation(S, "inv-fresh")?.status).toBe("running");
  });

  it("fails every running investigation with a 0-minute threshold (server startup)", () => {
    expect(db.markStaleInvestigations(0)).toBe(1);
    expect(db.getInvestigation(S, "inv-fresh")?.status).toBe("failed");
    expect(db.getInvestigation(S, "inv-done")?.status).toBe("complete");
  });
});

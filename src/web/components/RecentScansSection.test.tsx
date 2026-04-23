import { describe, it, expect } from "vitest";
import { collapseCronTicks, type ScanRunListRow } from "./RecentScansSection.js";

const base: Omit<ScanRunListRow, "id" | "trigger" | "startedAt" | "hitsDispatched"> = {
  status: "complete", servicesProbed: 100, finishedAt: 0,
};

describe("collapseCronTicks", () => {
  it("collapses consecutive clean cron ticks into one group", () => {
    const rows: ScanRunListRow[] = [
      { ...base, id: "a", trigger: "cron", startedAt: 5, hitsDispatched: 0 },
      { ...base, id: "b", trigger: "cron", startedAt: 4, hitsDispatched: 0 },
      { ...base, id: "c", trigger: "cron", startedAt: 3, hitsDispatched: 0 },
      { ...base, id: "d", trigger: "manual", startedAt: 2, hitsDispatched: 1 },
      { ...base, id: "e", trigger: "cron", startedAt: 1, hitsDispatched: 2 },
    ];
    const collapsed = collapseCronTicks(rows);
    expect(collapsed).toHaveLength(3);
    expect((collapsed[0] as { kind: "collapsed"; count: number }).count).toBe(3);
    expect((collapsed[1] as { kind: "row"; row: ScanRunListRow }).row.id).toBe("d");
    expect((collapsed[2] as { kind: "row"; row: ScanRunListRow }).row.id).toBe("e");
  });

  it("does not collapse manual triggers", () => {
    const rows: ScanRunListRow[] = [
      { ...base, id: "a", trigger: "manual", startedAt: 2, hitsDispatched: 0 },
      { ...base, id: "b", trigger: "manual", startedAt: 1, hitsDispatched: 0 },
    ];
    expect(collapseCronTicks(rows)).toHaveLength(2);
  });

  it("does not collapse cron ticks with hits", () => {
    const rows: ScanRunListRow[] = [
      { ...base, id: "a", trigger: "cron", startedAt: 2, hitsDispatched: 1 },
      { ...base, id: "b", trigger: "cron", startedAt: 1, hitsDispatched: 3 },
    ];
    expect(collapseCronTicks(rows)).toHaveLength(2);
  });

  it("keeps a single clean cron tick as a row (no group of 1)", () => {
    const rows: ScanRunListRow[] = [
      { ...base, id: "a", trigger: "cron", startedAt: 2, hitsDispatched: 0 },
      { ...base, id: "b", trigger: "cron", startedAt: 1, hitsDispatched: 1 },
    ];
    const collapsed = collapseCronTicks(rows);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]!.kind).toBe("row");
  });

  it("handles empty input", () => {
    expect(collapseCronTicks([])).toEqual([]);
  });
});

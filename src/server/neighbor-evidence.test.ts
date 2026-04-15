import { describe, it, expect } from "vitest";
import { selectNeighborsForEvidenceFetch } from "./neighbor-evidence.js";
import type { Neighbor } from "../types/workflow-state.js";

function mkNeighbor(
  name: string,
  status: Neighbor["status"],
  options: Partial<Neighbor> = {},
): Neighbor {
  return {
    name,
    status,
    directions: ["downstream"],
    inServiceRegistry: true,
    ...options,
  };
}

describe("selectNeighborsForEvidenceFetch", () => {
  it("drops healthy neighbors by default", () => {
    const input = [
      mkNeighbor("a", "healthy"),
      mkNeighbor("b", "degraded"),
      mkNeighbor("c", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input);
    expect(out.map((n) => n.name)).toEqual(["c", "b"]);
  });

  it("drops neighbors not in the service registry by default", () => {
    const input = [
      mkNeighbor("a", "unhealthy", { inServiceRegistry: false }),
      mkNeighbor("b", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input);
    expect(out.map((n) => n.name)).toEqual(["b"]);
  });

  it("respects maxNeighbors hard cap", () => {
    const input = [
      mkNeighbor("a", "unhealthy"),
      mkNeighbor("b", "unhealthy"),
      mkNeighbor("c", "unhealthy"),
      mkNeighbor("d", "unhealthy"),
      mkNeighbor("e", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input, { maxNeighbors: 2 });
    expect(out).toHaveLength(2);
  });

  it("sorts by severity first (unhealthy > degraded > unknown > healthy)", () => {
    const input = [
      mkNeighbor("u", "unknown"),
      mkNeighbor("d", "degraded"),
      mkNeighbor("c", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input);
    expect(out.map((n) => n.name)).toEqual(["c", "d", "u"]);
  });

  it("uses requestRate as a tiebreaker within the same severity", () => {
    const input = [
      mkNeighbor("low", "unhealthy", { requestRate: "10" }),
      mkNeighbor("high", "unhealthy", { requestRate: "500" }),
      mkNeighbor("mid", "unhealthy", { requestRate: "50" }),
    ];
    const out = selectNeighborsForEvidenceFetch(input);
    expect(out.map((n) => n.name)).toEqual(["high", "mid", "low"]);
  });

  it("treats missing requestRate as 0 for ranking", () => {
    const input = [
      mkNeighbor("norate", "unhealthy"),
      mkNeighbor("withrate", "unhealthy", { requestRate: "5" }),
    ];
    const out = selectNeighborsForEvidenceFetch(input);
    expect(out.map((n) => n.name)).toEqual(["withrate", "norate"]);
  });

  it("minStatus=unhealthy excludes degraded and unknown", () => {
    const input = [
      mkNeighbor("u", "unknown"),
      mkNeighbor("d", "degraded"),
      mkNeighbor("c", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input, { minStatus: "unhealthy" });
    expect(out.map((n) => n.name)).toEqual(["c"]);
  });

  it("requireInRegistry=false keeps off-registry neighbors", () => {
    const input = [
      mkNeighbor("a", "unhealthy", { inServiceRegistry: false }),
      mkNeighbor("b", "unhealthy"),
    ];
    const out = selectNeighborsForEvidenceFetch(input, { requireInRegistry: false });
    expect(out).toHaveLength(2);
  });
});

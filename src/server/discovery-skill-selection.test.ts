import { describe, expect, it, vi } from "vitest";
import type { Skill, SkillStore } from "../skills/store.js";
import { resolveDiscoverySkills } from "./discovery-skill-selection.js";

function skill(id: string, scope: Skill["scope"] = ["discovery"]): Skill {
  return {
    id,
    title: id,
    services: [],
    alerts: [],
    tags: [],
    scope,
    filePath: `${id}.md`,
    body: "body",
  };
}

function store(skills: Skill[], maxPerQuery = 50): SkillStore {
  const byId = new Map(skills.map((s) => [s.id, s]));
  return {
    maxPerQuery,
    getById: vi.fn((id: string) => byId.get(id)),
    getAllForScopeEnabled: vi.fn((target: string, disabledIds: Set<string>) =>
      skills.filter((s) => s.scope.includes(target as Skill["scope"][number]) && !disabledIds.has(s.id)),
    ),
  } as unknown as SkillStore;
}

describe("discovery skill resolution", () => {
  it("returns stack-enabled discovery-scoped skills", () => {
    const selected = resolveDiscoverySkills({
      skillStore: store([skill("consul-bare-metal")]),
    });

    expect(selected.map((s) => s.id)).toEqual(["consul-bare-metal"]);
  });

  it("does not return non-discovery-scoped skills", () => {
    const selected = resolveDiscoverySkills({
      skillStore: store([skill("consul-bare-metal"), skill("chat-only", ["chat"])]),
    });

    expect(selected.map((s) => s.id)).toEqual(["consul-bare-metal"]);
  });

  it("skips discovery skills when the stack disabled them globally", () => {
    const selected = resolveDiscoverySkills({
      skillStore: store([skill("consul-bare-metal")]),
      db: {
        getDisabledSkills: vi.fn(() => new Set(["consul-bare-metal"])),
      },
      stackId: "stack-1",
    });

    expect(selected).toEqual([]);
  });

  it("caps the result at maxPerQuery (the discovery path must re-cap; getAllForScope no longer does)", () => {
    const selected = resolveDiscoverySkills({
      skillStore: store([skill("a"), skill("b"), skill("c"), skill("d")], 2),
    });

    expect(selected.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Skill, SkillStore } from "../skills/store.js";
import {
  getConfiguredDiscoverySkillIds,
  resolveDiscoverySkills,
} from "./discovery-skill-selection.js";

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

function store(skills: Skill[]): SkillStore {
  const byId = new Map(skills.map((s) => [s.id, s]));
  return {
    getById: vi.fn((id: string) => byId.get(id)),
    getAllForScopeEnabled: vi.fn((target: string, disabledIds: Set<string>) =>
      skills.filter((s) => s.scope.includes(target as Skill["scope"][number]) && !disabledIds.has(s.id)),
    ),
  } as unknown as SkillStore;
}

describe("discovery skill selection", () => {
  it("defaults to stack-enabled discovery-scoped skills when no explicit selection exists", () => {
    const selected = resolveDiscoverySkills({
      skillStore: store([skill("consul-bare-metal")]),
      discoveryConfig: {},
    });

    expect(selected.map((s) => s.id)).toEqual(["consul-bare-metal"]);
  });

  it("uses only explicitly configured discovery-scoped skills when config provides an override", () => {
    const selected = resolveDiscoverySkills({
      skillStore: store([skill("consul-bare-metal"), skill("chat-only", ["chat"])]),
      discoveryConfig: { enabledSkillIds: ["consul-bare-metal", "chat-only", "missing"] },
    });

    expect(selected.map((s) => s.id)).toEqual(["consul-bare-metal"]);
  });

  it("supports explicit empty config override for config-only deployments", () => {
    const ids = getConfiguredDiscoverySkillIds({
      discoveryConfig: { enabledSkillIds: [] },
    });

    expect(ids).toEqual([]);
  });

  it("skips an explicitly enabled skill when the stack disabled it globally", () => {
    const selected = resolveDiscoverySkills({
      skillStore: store([skill("consul-bare-metal")]),
      db: {
        getDisabledSkills: vi.fn(() => new Set(["consul-bare-metal"])),
      },
      stackId: "stack-1",
      discoveryConfig: { enabledSkillIds: ["consul-bare-metal"] },
    });

    expect(selected).toEqual([]);
  });

  it("skips fallback discovery skills when the stack disabled them globally", () => {
    const selected = resolveDiscoverySkills({
      skillStore: store([skill("consul-bare-metal")]),
      db: {
        getDisabledSkills: vi.fn(() => new Set(["consul-bare-metal"])),
      },
      stackId: "stack-1",
      discoveryConfig: {},
    });

    expect(selected).toEqual([]);
  });
});

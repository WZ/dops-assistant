import { createLogger } from "../logger.js";
import type { DiscoveryConfig } from "../config/schema.js";
import type { Skill, SkillStore } from "../skills/store.js";

const logger = createLogger("discovery-skill-selection");

interface DiscoverySkillSettingsStore {
  getDisabledSkills?: (stackId: string) => Set<string>;
}

export interface DiscoverySkillResolutionInput {
  skillStore?: SkillStore;
  db?: DiscoverySkillSettingsStore;
  stackId?: string;
  discoveryConfig?: Pick<DiscoveryConfig, "enabledSkillIds">;
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function getConfiguredDiscoverySkillIds(input: DiscoverySkillResolutionInput): string[] | null {
  if (input.discoveryConfig?.enabledSkillIds !== undefined) {
    return uniqueIds(input.discoveryConfig.enabledSkillIds);
  }

  return null;
}

function getDisabledSkillIds(input: DiscoverySkillResolutionInput): Set<string> {
  return input.db && input.stackId
    ? input.db.getDisabledSkills?.(input.stackId) ?? new Set<string>()
    : new Set<string>();
}

export function resolveDiscoverySkills(input: DiscoverySkillResolutionInput): Skill[] {
  if (!input.skillStore) return [];

  const disabledIds = getDisabledSkillIds(input);
  // GUI-managed stacks use the normal stack-level skill enable/disable toggle:
  // every enabled skill whose scope includes "discovery" is injected.
  //
  // Config-only deployments can optionally narrow or disable discovery skills
  // via discovery.enabledSkillIds. This is intentionally not backed by a
  // separate GUI toggle; scope + stack enabled state is the runtime contract.
  const ids = getConfiguredDiscoverySkillIds(input);
  if (ids === null) {
    return input.skillStore.getAllForScopeEnabled("discovery", disabledIds);
  }
  if (ids.length === 0) return [];

  const out: Skill[] = [];

  for (const id of ids) {
    if (disabledIds.has(id)) {
      logger.debug({ skillId: id, stackId: input.stackId }, "Skipping explicitly configured discovery skill because it is disabled for this stack");
      continue;
    }

    const skill = input.skillStore.getById(id);
    if (!skill) {
      logger.warn({ skillId: id, stackId: input.stackId }, "Configured discovery skill was not found");
      continue;
    }
    if (!skill.scope.includes("discovery")) {
      logger.warn({ skillId: id, stackId: input.stackId, scope: skill.scope }, "Configured discovery skill is not scoped for discovery");
      continue;
    }
    out.push(skill);
  }

  return out;
}

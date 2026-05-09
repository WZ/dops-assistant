import { createLogger } from "../logger.js";
import type { DiscoveryConfig } from "../config/schema.js";
import type { Skill, SkillStore } from "../skills/store.js";

const logger = createLogger("discovery-skill-selection");

export const DISCOVERY_ENABLED_SKILL_IDS_KEY = "discovery.enabledSkillIds";

interface DiscoverySkillSettingsStore {
  getStackSetting?: (stackId: string, key: string) => string | undefined;
  getDisabledSkills?: (stackId: string) => Set<string>;
}

export interface DiscoverySkillSelectionInput {
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

export function parseDiscoverySkillIds(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return uniqueIds(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return null;
  }
}

export function getConfiguredDiscoverySkillIds(input: DiscoverySkillSelectionInput): string[] | null {
  if (input.db && input.stackId) {
    const stackIds = parseDiscoverySkillIds(
      input.db.getStackSetting?.(input.stackId, DISCOVERY_ENABLED_SKILL_IDS_KEY),
    );
    if (stackIds !== null) return stackIds;
  }

  if (input.discoveryConfig?.enabledSkillIds !== undefined) {
    return uniqueIds(input.discoveryConfig.enabledSkillIds);
  }

  return null;
}

function getDisabledSkillIds(input: DiscoverySkillSelectionInput): Set<string> {
  return input.db && input.stackId
    ? input.db.getDisabledSkills?.(input.stackId) ?? new Set<string>()
    : new Set<string>();
}

export function resolveDiscoverySkills(input: DiscoverySkillSelectionInput): Skill[] {
  if (!input.skillStore) return [];

  const disabledIds = getDisabledSkillIds(input);
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

export const resolveExplicitDiscoverySkills = resolveDiscoverySkills;

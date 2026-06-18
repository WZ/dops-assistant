import type { Skill, SkillStore } from "../skills/store.js";

interface DiscoverySkillSettingsStore {
  getDisabledSkills?: (stackId: string) => Set<string>;
}

export interface DiscoverySkillResolutionInput {
  skillStore?: SkillStore;
  db?: DiscoverySkillSettingsStore;
  stackId?: string;
}

function getDisabledSkillIds(input: DiscoverySkillResolutionInput): Set<string> {
  return input.db && input.stackId
    ? input.db.getDisabledSkills?.(input.stackId) ?? new Set<string>()
    : new Set<string>();
}

export function resolveDiscoverySkills(input: DiscoverySkillResolutionInput): Skill[] {
  if (!input.skillStore) return [];

  const disabledIds = getDisabledSkillIds(input);
  // Cap to maxPerQuery: getAllForScope no longer caps itself (the investigation
  // path filters-then-caps), so the discovery path must re-cap here or it would
  // inject every enabled discovery skill into the prompt (token bloat).
  return input.skillStore.getAllForScopeEnabled("discovery", disabledIds).slice(0, input.skillStore.maxPerQuery);
}

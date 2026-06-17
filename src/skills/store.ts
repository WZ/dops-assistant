import { readdir, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import matter from "gray-matter";
import { createLogger } from "../logger.js";

const logger = createLogger();

// ── Types ───────────────────────────────────────────────────────────────────

export type SkillScope = "investigation" | "discovery" | "chat";

export const VALID_SCOPES: readonly SkillScope[] = ["investigation", "discovery", "chat"] as const;

export const DEFAULT_SCOPE: readonly SkillScope[] = ["investigation"] as const;

export interface SkillMetadata {
  id: string;
  title: string;
  services: string[];
  alerts: string[];
  tags: string[];
  scope: SkillScope[];
  /** Optional generic targeting: this skill is only eligible for a service
   *  whose discovered metric queries contain this substring (case-insensitive).
   *  Keeps infra-type knowledge (e.g. a Consul health metric) in the skill,
   *  not hardcoded in the engine. Untargeted skills (undefined) are always eligible. */
  appliesToServiceMetric?: string;
  /** Optional infra-agnostic engine metadata (read by the orchestrator so it
   *  carries NO infra literals). All are scoped to a matched investigation skill;
   *  `$service` is substituted with the incident service name.
   *  - healthySignal: a PromQL that returns ≥1 when the service is HEALTHY on its
   *    primary signal. The confirm-gate evaluates it; healthy → force inconclusive.
   *  - identityHint: one-line steer prepended to the decide-move prompt.
   *  - incompatibleClaims: a regex of conclusion text that contradicts this
   *    service's infra type (the service-type guard rejects a confirm matching it). */
  healthySignal?: string;
  identityHint?: string;
  incompatibleClaims?: string;
  filePath: string;
}

export interface Skill extends SkillMetadata {
  body: string;
}

export interface SkillSearchOpts {
  service?: string;
  alert?: string;
  query?: string;
  scope?: SkillScope;
}

/** Filter skills to those whose scope includes the given target. */
export function filterSkillsByScope(skills: Skill[], target: SkillScope): Skill[] {
  return skills.filter(s => s.scope.includes(target));
}

export interface SkillStoreConfig {
  dir: string;
  maxPerQuery: number;
  maxCharsPerSkill: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Derive a URL-safe id from a filename (strip extension, lowercase). */
function filenameToId(filename: string): string {
  return basename(filename, extname(filename)).toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/** Trimmed non-empty string, else undefined — for optional frontmatter fields. */
function optStr(x: unknown): string | undefined {
  return typeof x === "string" && x.trim() ? x.trim() : undefined;
}

/** Validate and normalize explicit skill ids before deriving on-disk paths. */
function normalizeSkillId(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("Invalid skill id");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error("Invalid skill id");
  }

  const normalized = filenameToId(trimmed);
  if (normalized !== trimmed) {
    throw new Error("Invalid skill id");
  }
  return normalized;
}

/** Tokenize a string into lowercase words (≥3 chars). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[-_\s.,;:!?'"()]+/)
    .filter((t) => t.length >= 3);
}

// ── SkillStore ──────────────────────────────────────────────────────────────

export class SkillStore {
  private skills = new Map<string, Skill>();
  private readonly dir: string;
  readonly maxPerQuery: number;
  readonly maxCharsPerSkill: number;

  constructor(config: SkillStoreConfig) {
    this.dir = config.dir;
    this.maxPerQuery = config.maxPerQuery;
    this.maxCharsPerSkill = config.maxCharsPerSkill;
  }

  /** Load/reload all skills from disk. */
  async loadAll(): Promise<void> {
    this.skills.clear();
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      logger.debug({ dir: this.dir }, "Skills directory does not exist, skipping load");
      return;
    }

    const mdFiles = files.filter((f) => f.endsWith(".md"));
    for (const file of mdFiles) {
      try {
        const filePath = join(this.dir, file);
        const raw = await readFile(filePath, "utf-8");
        const { data, content } = matter(raw);
        const id = filenameToId(file);
        // Parse and validate scope from frontmatter, default to investigation-only
        let scope: SkillScope[] = [...DEFAULT_SCOPE];
        if (Array.isArray(data.scope) && data.scope.length > 0) {
          const validScopes = data.scope
            .map(String)
            .filter((s): s is SkillScope => (VALID_SCOPES as readonly string[]).includes(s));
          if (validScopes.length > 0) {
            scope = validScopes;
          } else {
            logger.warn({ file, scope: data.scope }, "Skill has invalid scope values, using default");
          }
        }

        this.skills.set(id, {
          id,
          title: String(data.title ?? id),
          services: Array.isArray(data.services) ? data.services.map(String) : [],
          alerts: Array.isArray(data.alerts) ? data.alerts.map(String) : [],
          tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
          scope,
          appliesToServiceMetric: optStr(data.appliesToServiceMetric),
          healthySignal: optStr(data.healthySignal),
          identityHint: optStr(data.identityHint),
          incompatibleClaims: optStr(data.incompatibleClaims),
          filePath,
          body: content.trim(),
        });
      } catch (err) {
        logger.warn({ file, err }, "Failed to parse skill file");
      }
    }
    logger.info({ count: this.skills.size }, "Skills loaded");
  }

  /** Find skills matching a query context, scored by relevance.
   *  If opts.scope is provided, only skills with that scope are considered
   *  (filtering happens BEFORE the relevance cap to prevent scope starvation). */
  search(opts: SkillSearchOpts): Skill[] {
    const scored: Array<{ skill: Skill; score: number }> = [];

    for (const skill of this.skills.values()) {
      // Scope filter: if scope is specified, skip skills that don't include it
      if (opts.scope && !skill.scope.includes(opts.scope)) continue;
      let score = 0;

      // Exact service match (highest priority)
      if (opts.service) {
        const svc = opts.service.toLowerCase();
        if (skill.services.some((s) => s.toLowerCase() === svc)) {
          score += 10;
        }
      }

      // Exact alert match
      if (opts.alert) {
        const alert = opts.alert.toLowerCase();
        if (skill.alerts.some((a) => a.toLowerCase() === alert)) {
          score += 10;
        }
      }

      // Tag token-overlap with query text
      if (opts.query) {
        const queryTokens = tokenize(opts.query);
        const tagTokens = skill.tags.map((t) => t.toLowerCase());
        // Also include title tokens for broader matching
        const titleTokens = tokenize(skill.title);
        const allSkillTokens = [...tagTokens, ...titleTokens];

        if (queryTokens.length > 0 && allSkillTokens.length > 0) {
          const overlap = queryTokens.filter((qt) =>
            allSkillTokens.some((st) => st === qt || (st.length >= 5 && qt.length >= 5 && (st.includes(qt) || qt.includes(st)))),
          ).length;
          const ratio = overlap / Math.max(queryTokens.length, 1);
          score += ratio * 5;
        }
      }

      if (score >= 2) {
        scored.push({ skill, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, this.maxPerQuery).map((s) => s.skill);
  }

  /** Return all skills whose scope includes the given target.
   *  Unlike search(), this does NOT require service/alert/tag matching —
   *  it returns every skill scoped to the target. Used by discovery
   *  when there's no specific service/alert context to match against.
   *  Results are sorted by title for deterministic ordering, capped by maxPerQuery. */
  getAllForScope(target: SkillScope): Skill[] {
    const matching = filterSkillsByScope([...this.skills.values()], target);
    matching.sort((a, b) => a.title.localeCompare(b.title));
    return matching.slice(0, this.maxPerQuery);
  }

  /** Like search() but excludes disabled skills. Used in per-stack contexts. */
  searchEnabled(opts: SkillSearchOpts, disabledIds: Set<string>): Skill[] {
    return this.search(opts).filter(s => !disabledIds.has(s.id));
  }

  /** Like getAllForScope() but excludes disabled skills. Used in per-stack contexts. */
  getAllForScopeEnabled(target: SkillScope, disabledIds: Set<string>): Skill[] {
    return this.getAllForScope(target).filter(s => !disabledIds.has(s.id));
  }

  /** Get all skill metadata (without body). */
  getAll(): SkillMetadata[] {
    return [...this.skills.values()].map(({ body: _, ...meta }) => meta);
  }

  /** Get a full skill by id. */
  getById(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  /** Save a skill (create or update). Returns the saved skill. */
  async save(
    id: string | undefined,
    frontmatter: { title: string; services: string[]; alerts: string[]; tags: string[]; scope?: SkillScope[]; appliesToServiceMetric?: string; healthySignal?: string; identityHint?: string; incompatibleClaims?: string },
    body: string,
  ): Promise<Skill> {
    const skillId = id
      ? normalizeSkillId(id)
      : (filenameToId(frontmatter.title || "untitled") || "untitled");
    const filename = `${skillId}.md`;
    const filePath = join(this.dir, filename);

    // Ensure directory exists
    await mkdir(this.dir, { recursive: true });

    const scope = frontmatter.scope?.length ? frontmatter.scope : [...DEFAULT_SCOPE];
    const content = matter.stringify(body, {
      title: frontmatter.title,
      services: frontmatter.services,
      alerts: frontmatter.alerts,
      tags: frontmatter.tags,
      scope,
      ...(frontmatter.appliesToServiceMetric ? { appliesToServiceMetric: frontmatter.appliesToServiceMetric } : {}),
      ...(frontmatter.healthySignal ? { healthySignal: frontmatter.healthySignal } : {}),
      ...(frontmatter.identityHint ? { identityHint: frontmatter.identityHint } : {}),
      ...(frontmatter.incompatibleClaims ? { incompatibleClaims: frontmatter.incompatibleClaims } : {}),
    });

    await writeFile(filePath, content, "utf-8");

    const skill: Skill = {
      id: skillId,
      title: frontmatter.title,
      services: frontmatter.services,
      alerts: frontmatter.alerts,
      tags: frontmatter.tags,
      scope,
      appliesToServiceMetric: frontmatter.appliesToServiceMetric?.trim() || undefined,
      healthySignal: frontmatter.healthySignal?.trim() || undefined,
      identityHint: frontmatter.identityHint?.trim() || undefined,
      incompatibleClaims: frontmatter.incompatibleClaims?.trim() || undefined,
      filePath,
      body,
    };
    this.skills.set(skillId, skill);
    logger.info({ id: skillId }, "Skill saved");
    return skill;
  }

  /** Delete a skill by id. */
  async delete(id: string): Promise<void> {
    const skill = this.skills.get(id);
    if (!skill) return;
    try {
      await unlink(skill.filePath);
    } catch {
      // File already gone
    }
    this.skills.delete(id);
    logger.info({ id }, "Skill deleted");
  }

  /** Format matched skills for prompt injection (capped per skill). */
  formatForPrompt(skills: Skill[]): string {
    if (skills.length === 0) return "";
    const sections = skills.map((s) => {
      const truncatedBody = s.body.length > this.maxCharsPerSkill
        ? s.body.slice(0, this.maxCharsPerSkill) + "\n...[truncated]"
        : s.body;
      return `### Skill: ${s.title}\n${truncatedBody}`;
    });
    return `## Team Knowledge (Skills)\nThe following runbooks were found for this service. Use them to inform your investigation:\n\n${sections.join("\n\n")}`;
  }
}

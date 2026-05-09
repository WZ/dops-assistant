import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Compass, FilePlus, Plus } from "lucide-react";
import { SkillEditor } from "./SkillEditor";
import { useStackContext } from "../contexts/StackContext";

interface SkillMeta {
  id: string;
  title: string;
  services: string[];
  alerts: string[];
  tags: string[];
  scope?: string[];
  enabled?: boolean;
}

interface SkillFull extends SkillMeta {
  body: string;
}

interface DiscoverySkillSelection {
  enabledSkillIds: string[];
}

const SCOPE_COLORS: Record<string, string> = {
  investigation: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  discovery: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  chat: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
};

const TEMPLATES: Record<string, { title: string; body: string }> = {
  health: {
    title: "Health Check",
    body: `## When to use
Service health check is needed.

## Steps
1. Check service availability and response times
2. Verify dependent services are healthy
3. Check recent deployment history

## Known gotchas
- (add known issues here)`,
  },
  alert: {
    title: "Alert Investigation",
    body: `## When to use
This alert is firing.

## Investigation steps
1. Check the alert condition metrics
2. Correlate with recent changes
3. Check for cascading failures

## Remediation
- (add remediation steps here)`,
  },
  logs: {
    title: "Log Analysis Pattern",
    body: `## When to use
Specific log patterns indicate an issue.

## What to look for
1. Error patterns and frequency
2. Stack traces and exception types
3. Correlation with metric anomalies

## Common patterns
- (add common log patterns here)`,
  },
  infra: {
    title: "Infrastructure Troubleshooting",
    body: `## When to use
Infrastructure-level issues suspected.

## Investigation steps
1. Check node resource utilization (CPU, memory, disk)
2. Check pod status and recent restarts
3. Verify network connectivity between components

## Known gotchas
- (add known issues here)`,
  },
  blank: {
    title: "New Skill",
    body: "",
  },
};

export function SkillsPage() {
  const { activeStackId, stackFetch } = useStackContext();
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [discoveryEnabledSkillIds, setDiscoveryEnabledSkillIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<SkillFull | null>(null);
  const [creating, setCreating] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const skillsRequestRef = useRef(0);

  const fetchSkills = useCallback(async () => {
    const requestId = ++skillsRequestRef.current;
    try {
      const [skillsRes, discoveryRes] = await Promise.all([
        stackFetch("/api/skills"),
        stackFetch("/api/discovery/skills"),
      ]);
      const nextSkills = skillsRes.ok ? await skillsRes.json() : [];
      const discoverySelection = discoveryRes.ok
        ? await discoveryRes.json() as DiscoverySkillSelection
        : { enabledSkillIds: [] };
      if (requestId !== skillsRequestRef.current) return;
      setSkills(Array.isArray(nextSkills) ? nextSkills : []);
      setDiscoveryEnabledSkillIds(new Set(
        Array.isArray(discoverySelection.enabledSkillIds) ? discoverySelection.enabledSkillIds : [],
      ));
    } catch { /* ignore */ }
  }, [stackFetch]);

  useEffect(() => {
    setSkills([]);
    setDiscoveryEnabledSkillIds(new Set());
    setEditing(null);
    setCreating(false);
    void fetchSkills();
  }, [activeStackId, fetchSkills]);

  const handleEdit = async (id: string) => {
    try {
      const res = await stackFetch(`/api/skills/${id}`);
      if (res.ok) setEditing(await res.json());
    } catch { /* ignore */ }
  };

  const handleCreate = (template: string) => {
    const t = TEMPLATES[template] ?? TEMPLATES.blank!;
    setEditing({
      id: "",
      title: t.title,
      services: [],
      alerts: [],
      tags: [],
      body: t.body,
    });
    setCreating(true);
    setShowTemplates(false);
  };

  const handleSave = async (skill: SkillFull) => {
    const method = creating ? "POST" : "PUT";
    const url = creating ? "/api/skills" : `/api/skills/${skill.id}`;
    try {
      await stackFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skill),
      });
      setEditing(null);
      setCreating(false);
      void fetchSkills();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    try {
      await stackFetch(`/api/skills/${id}`, { method: "DELETE" });
      setEditing(null);
      setCreating(false);
      void fetchSkills();
    } catch { /* ignore */ }
  };

  const handleToggle = async (id: string, currentEnabled: boolean) => {
    try {
      await stackFetch(`/api/skills/${id}/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
      setSkills(prev => prev.map(s => s.id === id ? { ...s, enabled: !currentEnabled } : s));
    } catch { /* ignore */ }
  };

  const handleToggleDiscovery = async (id: string) => {
    const previous = new Set(discoveryEnabledSkillIds);
    const next = new Set(discoveryEnabledSkillIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDiscoveryEnabledSkillIds(next);

    try {
      const res = await stackFetch("/api/discovery/skills", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledSkillIds: [...next] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json() as DiscoverySkillSelection;
      setDiscoveryEnabledSkillIds(new Set(
        Array.isArray(saved.enabledSkillIds) ? saved.enabledSkillIds : [...next],
      ));
    } catch {
      setDiscoveryEnabledSkillIds(previous);
    }
  };

  if (editing) {
    return (
      <SkillEditor
        skill={editing}
        isNew={creating}
        onSave={handleSave}
        onDelete={creating ? undefined : handleDelete}
        onCancel={() => { setEditing(null); setCreating(false); }}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto relative z-[2]">
      {/* Title row */}
      <div className="mb-6 animate-fade-up flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90">Skills</h1>
          <p className="text-xs font-mono text-muted-foreground/70 mt-1 tracking-wide">
            {skills.length} skill{skills.length !== 1 ? "s" : ""} defined
          </p>
        </div>
        <div className="relative shrink-0">
          <Button
            variant="outline"
            onClick={() => setShowTemplates(!showTemplates)}
            className="h-9 px-4 text-[12px] font-mono bg-primary/10 border-primary/20 text-primary hover:bg-primary/15 hover:text-primary rounded-lg gap-1.5"
          >
            <Plus size={12} className="!size-auto" />
            New Skill
          </Button>
          {showTemplates && (
            <div className="absolute right-0 top-full mt-1 w-52 rounded-lg border border-border/50 bg-card shadow-lg z-10 py-1 animate-fade-in">
              {Object.entries(TEMPLATES).map(([key, t]) => (
                <Button
                  key={key}
                  variant="ghost"
                  onClick={() => handleCreate(key)}
                  className="w-full justify-start rounded-none h-auto px-3 py-2 text-xs font-body text-foreground/70 hover:bg-secondary/50 hover:text-foreground"
                >
                  {t.title}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mb-5 rounded-lg border border-border/40 bg-card/40 px-4 py-3 flex items-start gap-3 animate-fade-in max-w-4xl">
        <span aria-hidden className="text-base mt-0.5">🌐</span>
        <div>
          <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground/80">
            Global — visible to all stacks
          </div>
          <p className="text-xs text-muted-foreground/70 mt-0.5 max-w-xl">
            Skills are shared across stacks. Edits here affect every stack. The enable toggle is per-stack — turn a skill off on one stack without affecting the others.
          </p>
        </div>
      </div>

      <div className="max-w-4xl">
          {skills.length === 0 ? (
            <div className="text-center py-12 animate-fade-in">
              <div className="w-12 h-12 rounded-xl bg-primary/8 border border-primary/15 flex items-center justify-center mx-auto mb-3">
                <FilePlus size={20} strokeWidth={1.5} className="!size-auto text-primary/50" />
              </div>
              <p className="text-sm text-muted-foreground/50 font-body">No skills yet</p>
              <p className="text-[11px] text-muted-foreground/60 mt-1 font-mono">
                Create runbooks to guide investigations
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {skills.map((skill) => {
                const enabled = skill.enabled !== false;
                const isDiscoverySkill = skill.scope?.includes("discovery") ?? false;
                const discoveryEnabled = discoveryEnabledSkillIds.has(skill.id);
                return (
                  <div
                    key={skill.id}
                    className={`relative rounded-xl border p-4 transition-all ${enabled ? "border-border/40 bg-card/30 hover:border-primary/30 hover:bg-card/60" : "border-border/20 bg-card/10 opacity-50"}`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <button
                        onClick={() => handleEdit(skill.id)}
                        className="text-left flex-1 min-w-0"
                      >
                        <h3 className={`text-sm font-display font-semibold transition-colors ${enabled ? "text-foreground/80 hover:text-foreground" : "text-foreground/40"}`}>
                          {skill.title}
                        </h3>
                        {skill.scope && skill.scope.length > 0 && (
                          <div className="flex gap-1 mt-0.5">
                            {skill.scope.map((s) => (
                              <span key={s} className={`px-1.5 py-0.5 text-[9px] font-mono rounded border ${SCOPE_COLORS[s] ?? "bg-secondary/50 text-muted-foreground/60"}`}>
                                {s}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                      <Switch
                        checked={enabled}
                        onCheckedChange={() => handleToggle(skill.id, enabled)}
                        className="shrink-0"
                      />
                    </div>
                    {isDiscoverySkill && (
                      <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-border/30 bg-secondary/20 px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <Compass size={13} strokeWidth={1.7} className="shrink-0 text-primary/70" />
                          <span className={`truncate text-[11px] font-mono ${enabled ? "text-foreground/70" : "text-muted-foreground/50"}`}>
                            Use in discovery
                          </span>
                        </div>
                        <Switch
                          checked={discoveryEnabled}
                          disabled={!enabled}
                          onCheckedChange={() => handleToggleDiscovery(skill.id)}
                          aria-label={`Use ${skill.title} in discovery`}
                          className="shrink-0"
                        />
                      </div>
                    )}
                    <button onClick={() => handleEdit(skill.id)} className="text-left w-full">
                      {skill.services.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {skill.services.map((s) => (
                            <span key={s} className="px-1.5 py-0.5 text-[9px] font-mono rounded bg-primary/10 text-primary/70 border border-primary/15">
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                      {skill.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {skill.tags.slice(0, 5).map((t) => (
                            <span key={t} className="px-1.5 py-0.5 text-[9px] font-mono rounded bg-secondary/50 text-muted-foreground/60">
                              {t}
                            </span>
                          ))}
                          {skill.tags.length > 5 && (
                            <span className="text-[9px] font-mono text-muted-foreground/70">+{skill.tags.length - 5}</span>
                          )}
                        </div>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
}

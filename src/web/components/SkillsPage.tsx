import { useState, useEffect } from "react";
import { SkillEditor } from "./SkillEditor";

interface SkillMeta {
  id: string;
  title: string;
  services: string[];
  alerts: string[];
  tags: string[];
}

interface SkillFull extends SkillMeta {
  body: string;
}

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
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [editing, setEditing] = useState<SkillFull | null>(null);
  const [creating, setCreating] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  const fetchSkills = () => {
    fetch("/api/skills")
      .then((r) => r.ok ? r.json() : [])
      .then(setSkills)
      .catch(() => {});
  };

  useEffect(() => { fetchSkills(); }, []);

  const handleEdit = async (id: string) => {
    try {
      const res = await fetch(`/api/skills/${id}`);
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
      await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skill),
      });
      setEditing(null);
      setCreating(false);
      fetchSkills();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/skills/${id}`, { method: "DELETE" });
      setEditing(null);
      setCreating(false);
      fetchSkills();
    } catch { /* ignore */ }
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
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-5 py-3 border-b border-border/40 flex items-center justify-between shrink-0">
        <h2 className="font-display text-sm font-bold tracking-wide uppercase text-foreground/80">Skills</h2>
        <div className="relative">
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded-md bg-primary/10 border border-primary/20 text-primary hover:bg-primary/15 transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            New Skill
          </button>
          {showTemplates && (
            <div className="absolute right-0 top-full mt-1 w-52 rounded-lg border border-border/50 bg-card shadow-lg z-10 py-1 animate-fade-in">
              {Object.entries(TEMPLATES).map(([key, t]) => (
                <button
                  key={key}
                  onClick={() => handleCreate(key)}
                  className="w-full text-left px-3 py-2 text-xs font-body text-foreground/70 hover:bg-secondary/50 hover:text-foreground transition-colors"
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-5 py-6">
          {skills.length === 0 ? (
            <div className="text-center py-12 animate-fade-in">
              <div className="w-12 h-12 rounded-xl bg-primary/8 border border-primary/15 flex items-center justify-center mx-auto mb-3">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary/50">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/>
                </svg>
              </div>
              <p className="text-sm text-muted-foreground/50 font-body">No skills yet</p>
              <p className="text-[11px] text-muted-foreground/30 mt-1 font-mono">
                Create runbooks to guide investigations
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {skills.map((skill) => (
                <button
                  key={skill.id}
                  onClick={() => handleEdit(skill.id)}
                  className="text-left p-4 rounded-xl border border-border/40 bg-card/30 hover:border-primary/30 hover:bg-card/60 transition-all group"
                >
                  <h3 className="text-sm font-display font-semibold text-foreground/80 group-hover:text-foreground transition-colors mb-1.5">
                    {skill.title}
                  </h3>
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
                        <span className="text-[9px] font-mono text-muted-foreground/40">+{skill.tags.length - 5}</span>
                      )}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

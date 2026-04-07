import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { renderMarkdown } from "../lib/renderMarkdown";

interface SkillData {
  id: string;
  title: string;
  services: string[];
  alerts: string[];
  tags: string[];
  scope?: string[];
  body: string;
}

const SCOPE_COLORS: Record<string, string> = {
  investigation: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  discovery: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  chat: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
};

interface SkillEditorProps {
  skill: SkillData;
  isNew: boolean;
  onSave: (skill: SkillData) => void;
  onDelete?: (id: string) => void;
  onCancel: () => void;
}

function TagInput({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const trimmed = input.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setInput("");
  };

  return (
    <div>
      <label className="block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 mb-1.5">
        {label}
      </label>
      <div className="flex flex-wrap gap-1 mb-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded-full bg-secondary/60 text-foreground/70 border border-border/30">
            {v}
            <Button variant="ghost" size="icon" onClick={() => onChange(values.filter((x) => x !== v))} className="h-auto w-auto p-0 text-muted-foreground/70 hover:text-destructive transition-colors">
              &times;
            </Button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
          placeholder={`Add ${label.toLowerCase()}...`}
          className="flex-1 px-2.5 py-1.5 text-xs font-mono rounded-md border border-border/40 bg-secondary/20 text-foreground/80 placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/30"
        />
        <Button variant="outline" onClick={addTag} className="px-2 py-1 h-auto text-[10px] font-mono border-border/30 text-muted-foreground/60 hover:text-foreground/70 hover:bg-secondary/40">
          Add
        </Button>
      </div>
    </div>
  );
}

export function SkillEditor({ skill, isNew, onSave, onDelete, onCancel }: SkillEditorProps) {
  const [title, setTitle] = useState(skill.title);
  const [services, setServices] = useState(skill.services);
  const [alerts, setAlerts] = useState(skill.alerts);
  const [tags, setTags] = useState(skill.tags);
  const [body, setBody] = useState(skill.body);
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSave = () => {
    onSave({ id: skill.id, title, services, alerts, tags, body });
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border/40 flex items-center justify-between shrink-0">
        <Button
          variant="ghost"
          onClick={onCancel}
          className="h-auto px-0 py-0 text-xs font-mono text-muted-foreground/60 hover:text-primary hover:bg-transparent transition-colors group"
        >
          <ArrowLeft size={12} className="!size-auto group-hover:-translate-x-0.5 transition-transform" />
          back to skills
        </Button>
        <div className="flex items-center gap-2">
          {onDelete && (
            confirmDelete ? (
              <div className="flex items-center gap-1.5 animate-fade-in">
                <span className="text-[10px] font-mono text-destructive/70">Delete?</span>
                <Button variant="destructive" onClick={() => onDelete(skill.id)} className="px-2 py-1 h-auto text-[10px] font-mono bg-transparent border border-destructive/30 text-destructive hover:bg-destructive/10">
                  Yes
                </Button>
                <Button variant="outline" onClick={() => setConfirmDelete(false)} className="px-2 py-1 h-auto text-[10px] font-mono border-border/30 text-muted-foreground/60 hover:bg-secondary/30">
                  No
                </Button>
              </div>
            ) : (
              <Button variant="destructive" onClick={() => setConfirmDelete(true)} className="px-2.5 py-1.5 h-auto text-[10px] font-mono bg-transparent border border-destructive/20 text-destructive/60 hover:text-destructive hover:border-destructive/40">
                Delete
              </Button>
            )
          )}
          <Button
            variant="outline"
            onClick={() => setPreview(!preview)}
            className={`px-2.5 py-1.5 h-auto text-[10px] font-mono ${preview ? "border-primary/30 text-primary bg-primary/5" : "border-border/30 text-muted-foreground/60 hover:text-foreground/70 hover:bg-secondary/30"}`}
          >
            {preview ? "Edit" : "Preview"}
          </Button>
          <Button
            variant="outline"
            onClick={handleSave}
            disabled={!title.trim()}
            className="px-3 py-1.5 h-auto text-[10px] font-mono bg-primary/10 border-primary/20 text-primary hover:bg-primary/15 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {isNew ? "Create" : "Save"}
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {/* Title */}
          <div>
            <label className="block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 mb-1.5">
              Title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 text-sm font-body rounded-md border border-border/40 bg-secondary/20 text-foreground/85 placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/30"
              placeholder="e.g., Investigate Kafka Consumer Lag"
            />
          </div>

          {/* Metadata fields */}
          <div className="grid gap-4 sm:grid-cols-3">
            <TagInput label="Services" values={services} onChange={setServices} />
            <TagInput label="Alerts" values={alerts} onChange={setAlerts} />
            <TagInput label="Tags" values={tags} onChange={setTags} />
          </div>

          {/* Scope (read-only) */}
          {skill.scope && skill.scope.length > 0 && (
            <div>
              <label className="block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 mb-1.5">
                Scope
              </label>
              <div className="flex gap-1.5">
                {skill.scope.map((s) => (
                  <span key={s} className={`px-2 py-1 text-[10px] font-mono rounded border ${SCOPE_COLORS[s] ?? "bg-secondary/50 text-muted-foreground/60 border-border/30"}`}>
                    {s}
                  </span>
                ))}
              </div>
              <p className="text-[9px] font-mono text-muted-foreground/40 mt-1">Set via frontmatter scope field in the markdown file</p>
            </div>
          )}

          {/* Body */}
          <div>
            <label className="block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 mb-1.5">
              Body
            </label>
            {preview ? (
              <div className="px-4 py-3 rounded-lg border border-border/30 bg-card/30 text-sm font-body min-h-[500px]">
                {renderMarkdown(body || "*No content*")}
              </div>
            ) : (
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="w-full px-3 py-2.5 text-sm font-mono rounded-md border border-border/40 bg-secondary/20 text-foreground/80 placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/30 min-h-[500px] resize-y leading-relaxed"
                placeholder="## When to use&#10;&#10;## Investigation steps&#10;1. &#10;&#10;## Known gotchas&#10;- "
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { safeGetItem } from "../lib/utils";
import { withBase } from "../lib/createStackFetch";

interface StackEditorProps {
  onCancel: () => void;
  onCreated: (stack: { id: string; name: string; slug: string }) => void;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function StackEditor({ onCancel, onCreated }: StackEditorProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManual, setSlugManual] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slugManual) setSlug(slugify(name));
  }, [name, slugManual]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const apiKey = safeGetItem("dops-api-key");
      if (apiKey) headers["X-API-Key"] = apiKey;
      const res = await fetch(withBase("/api/stacks"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: name.trim(),
          slug: slug || slugify(name),
          config: { providers: [] },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `Failed to create stack (${res.status})`);
      }
      const created = await res.json();
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create stack");
      setSaving(false);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/40 shrink-0">
        <Button
          variant="ghost"
          onClick={onCancel}
          className="h-auto px-0 py-0 text-xs font-mono text-muted-foreground/60 hover:text-primary hover:bg-transparent transition-colors group"
        >
          <ArrowLeft size={12} className="!size-auto group-hover:-translate-x-0.5 transition-transform" />
          back to stacks
        </Button>
        <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">
          New Stack
        </h2>
        <Button
          form="stack-editor-form"
          type="submit"
          disabled={saving || !name.trim()}
          variant="outline"
          className="px-3 py-1.5 h-auto text-[10px] font-mono bg-primary/10 border-primary/20 text-primary hover:bg-primary/15 hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed gap-1.5"
        >
          {saving ? (
            <>
              <Loader2 size={11} className="animate-spin !size-auto" />
              Creating...
            </>
          ) : (
            "Create"
          )}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <form id="stack-editor-form" onSubmit={handleSubmit} className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          <div>
            <label className="block font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 mb-1.5">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. EU-West Production"
              required
              autoFocus
              className="w-full px-3 py-2 text-sm font-body rounded-md border border-border/40 bg-secondary/20 text-foreground/85 placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/30"
            />
          </div>

          <div>
            <label className="block font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 mb-1.5">
              Slug
            </label>
            <input
              type="text"
              value={slug}
              onChange={(e) => {
                setSlugManual(true);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
              }}
              placeholder="eu-west-production"
              className={`w-full px-3 py-2 text-xs font-mono rounded-md border border-border/40 focus:outline-none focus:border-primary/30 ${
                slugManual
                  ? "bg-secondary/20 text-foreground/85"
                  : "bg-secondary/10 text-muted-foreground/70"
              }`}
            />
            <p className="font-body text-[10px] text-muted-foreground/50 mt-1">
              Used in URLs and webhook paths.
            </p>
          </div>

          {error && (
            <p className="font-mono text-[11px] text-destructive">{error}</p>
          )}
        </form>
      </div>
    </div>
  );
}

import { useState, useCallback, useEffect } from "react";
import { safeGetItem } from "../lib/utils";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface CreateStackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (stack: { id: string; name: string; slug: string }) => void;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function CreateStackDialog({ open, onOpenChange, onCreated }: CreateStackDialogProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManual, setSlugManual] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form on open
  useEffect(() => {
    if (open) {
      setName("");
      setSlug("");
      setSlugManual(false);
      setSaving(false);
      setError(null);
    }
  }, [open]);

  // Auto-generate slug from name unless manually edited
  useEffect(() => {
    if (!slugManual) {
      setSlug(slugify(name));
    }
  }, [name, slugManual]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim()) return;

      setSaving(true);
      setError(null);

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const apiKey = safeGetItem("dops-api-key");
        if (apiKey) headers["X-API-Key"] = apiKey;
        const res = await fetch("/api/stacks", {
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
    },
    [name, slug, onCreated],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-display text-base font-semibold">Create Stack</DialogTitle>
          <DialogDescription className="font-body text-xs text-muted-foreground/70">
            Add a new stack to manage a separate cluster or environment.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          {/* Name */}
          <div>
            <label className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground mb-1.5">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. EU-West Production"
              required
              autoFocus
              className="w-full font-body text-[13px] bg-secondary/30 border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/40"
            />
          </div>

          {/* Slug */}
          <div>
            <label className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground mb-1.5">
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
              className={`w-full font-mono text-xs border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 ${
                slugManual
                  ? "bg-secondary/30 text-foreground"
                  : "bg-secondary/20 text-muted-foreground/70"
              }`}
            />
            <p className="font-body text-[10px] text-muted-foreground/50 mt-1">
              Used in URLs and webhook paths
            </p>
          </div>

          {/* Error */}
          {error && (
            <p className="font-mono text-[10px] text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="font-mono text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !name.trim()}
              className="font-mono text-xs bg-primary/12 text-primary border border-primary/20 hover:bg-primary/20"
            >
              {saving ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Stack"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

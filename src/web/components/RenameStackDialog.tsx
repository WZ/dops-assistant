import { useState, useCallback, useEffect } from "react";
import { safeGetItem } from "../lib/utils";
import { withBase } from "../lib/createStackFetch";
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
import type { StackSummary } from "../../types/stack-types.js";

interface RenameStackDialogProps {
  stack: StackSummary | null;
  onOpenChange: (open: boolean) => void;
  onRenamed: () => Promise<void>;
}

export function RenameStackDialog({ stack, onOpenChange, onRenamed }: RenameStackDialogProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stack) {
      setName(stack.name);
      setSlug(stack.slug);
      setSaving(false);
      setError(null);
    }
  }, [stack]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!stack) return;
      const trimmedName = name.trim();
      if (!trimmedName) return;

      const nameChanged = trimmedName !== stack.name;
      const slugChanged = !stack.isDefault && slug !== stack.slug;
      if (!nameChanged && !slugChanged) {
        onOpenChange(false);
        return;
      }

      setSaving(true);
      setError(null);

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const apiKey = safeGetItem("dops-api-key");
        if (apiKey) headers["X-API-Key"] = apiKey;
        const body: { name?: string; slug?: string } = {};
        if (nameChanged) body.name = trimmedName;
        if (slugChanged) body.slug = slug;

        const res = await fetch(withBase(`/api/stacks/${stack.id}`), {
          method: "PUT",
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(data.error || `Failed to rename stack (${res.status})`);
        }

        await onRenamed();
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to rename stack");
        setSaving(false);
      }
    },
    [stack, name, slug, onOpenChange, onRenamed],
  );

  const open = !!stack;
  const trimmedName = name.trim();
  const nameChanged = stack ? trimmedName !== stack.name : false;
  const slugChanged = stack ? !stack.isDefault && slug !== stack.slug : false;
  const canSave = !!trimmedName && (nameChanged || slugChanged);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-display text-base font-semibold">Rename Stack</DialogTitle>
          <DialogDescription className="font-body text-xs text-muted-foreground/70">
            Update the display name{stack?.isDefault ? "" : " or slug"} for this stack.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div>
            <label className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground mb-1.5">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              maxLength={64}
              className="w-full font-body text-[13px] bg-secondary/30 border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/40"
            />
          </div>

          <div>
            <label className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground mb-1.5">
              Slug
            </label>
            <input
              type="text"
              value={slug}
              onChange={(e) =>
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
              }
              disabled={stack?.isDefault}
              maxLength={64}
              className={`w-full font-mono text-xs border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 ${
                stack?.isDefault
                  ? "bg-secondary/10 text-muted-foreground/60 cursor-not-allowed"
                  : "bg-secondary/30 text-foreground"
              }`}
            />
            <p className="font-body text-[10px] text-muted-foreground/50 mt-1">
              {stack?.isDefault
                ? "The default stack's slug is fixed (used to identify it on startup)."
                : "Used in URLs and webhook paths"}
            </p>
          </div>

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
              disabled={saving || !canSave}
              className="font-mono text-xs bg-primary/12 text-primary border border-primary/20 hover:bg-primary/20"
            >
              {saving ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

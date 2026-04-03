import { useState, useRef, useEffect, useCallback } from "react";
import { safeGetItem } from "../lib/utils";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// AliasEditor
// ---------------------------------------------------------------------------

export interface AliasEditorProps {
  serviceName: string;
  currentAlias: string | null;
  onSaved: (newAlias: string | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AliasEditor({
  serviceName,
  currentAlias,
  onSaved,
  open,
  onOpenChange,
}: AliasEditorProps) {
  const [value, setValue] = useState(currentAlias ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset value whenever the popover opens or the current alias changes
  useEffect(() => {
    if (open) {
      setValue(currentAlias ?? "");
      setError(null);
    }
  }, [open, currentAlias]);

  // Focus the input when it becomes visible
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const handleSave = useCallback(async () => {
    const trimmed = value.trim();
    setSaving(true);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const apiKey = safeGetItem("dops-api-key");
      if (apiKey) headers["X-API-Key"] = apiKey;
      const res = await fetch(
        `/api/services/${encodeURIComponent(serviceName)}/alias`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({ alias: trimmed || null }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      onSaved(trimmed || null);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [serviceName, value, onSaved, onOpenChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        onOpenChange(false);
      }
    },
    [handleSave, onOpenChange]
  );

  if (!open) return null;

  return (
    <div className="absolute z-50 mt-1 min-w-[240px] bg-card border border-border rounded-lg shadow-lg p-3 flex flex-col gap-2">
      <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground/60 mb-0.5">
        Display Name
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={serviceName}
        disabled={saving}
        className="bg-secondary/50 border border-border rounded-md text-sm px-3 py-1.5 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors disabled:opacity-60"
      />
      {error && (
        <p className="text-[11px] text-destructive font-mono">{error}</p>
      )}
      <div className="flex items-center gap-1.5 justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onOpenChange(false)}
          disabled={saving}
          className="min-h-[36px] px-2 text-[11px] font-mono text-muted-foreground hover:text-foreground"
        >
          <X size={12} className="mr-1" />
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving}
          className="min-h-[36px] px-2 text-[11px] font-mono bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Check size={12} className="mr-1" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TagEditor
// ---------------------------------------------------------------------------

export interface TagEditorProps {
  serviceName: string;
  currentTags: string[];
  onSaved: (newTags: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TagEditor({
  serviceName,
  currentTags,
  onSaved,
  open,
  onOpenChange,
}: TagEditorProps) {
  const [tags, setTags] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync tags when popover opens
  useEffect(() => {
    if (open) {
      setTags([...currentTags]);
      setInput("");
      setError(null);
    }
  }, [open, currentTags]);

  // Focus input when visible
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const saveTags = useCallback(
    async (newTags: string[]) => {
      setSaving(true);
      setError(null);
      try {
        const tagHeaders: Record<string, string> = { "Content-Type": "application/json" };
        const tagApiKey = safeGetItem("dops-api-key");
        if (tagApiKey) tagHeaders["X-API-Key"] = tagApiKey;
        const res = await fetch(
          `/api/services/${encodeURIComponent(serviceName)}/tags`,
          {
            method: "PUT",
            headers: tagHeaders,
            body: JSON.stringify({ tags: newTags }),
          }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        onSaved(newTags);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save");
        throw err; // re-throw so callers can bail
      } finally {
        setSaving(false);
      }
    },
    [serviceName, onSaved]
  );

  const addTag = useCallback(async () => {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed || tags.includes(trimmed)) {
      setInput("");
      return;
    }
    const newTags = [...tags, trimmed];
    setTags(newTags);
    setInput("");
    try {
      await saveTags(newTags);
    } catch {
      // error already set by saveTags; revert optimistic update
      setTags(tags);
    }
  }, [input, tags, saveTags]);

  const removeTag = useCallback(
    async (tag: string) => {
      const newTags = tags.filter((t) => t !== tag);
      setTags(newTags);
      try {
        await saveTags(newTags);
      } catch {
        setTags(tags);
      }
    },
    [tags, saveTags]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addTag();
      } else if (e.key === "Escape") {
        onOpenChange(false);
      } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
        removeTag(tags[tags.length - 1]);
      }
    },
    [addTag, input, onOpenChange, removeTag, tags]
  );

  if (!open) return null;

  return (
    <div className="absolute z-50 mt-1 min-w-[280px] bg-card border border-border rounded-lg shadow-lg p-3 flex flex-col gap-2">
      <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground/60 mb-0.5">
        Tags
      </div>

      {/* Existing tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="text-[11px] font-mono bg-secondary/50 text-muted-foreground/80 px-2 py-0.5 rounded flex items-center gap-1"
            >
              {tag}
              <button
                onClick={() => removeTag(tag)}
                disabled={saving}
                aria-label={`Remove tag ${tag}`}
                className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Add tag input */}
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add tag…"
          disabled={saving}
          className="flex-1 bg-secondary/50 border border-border rounded-md text-sm px-3 py-1.5 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors disabled:opacity-60"
        />
        <Button
          size="sm"
          onClick={addTag}
          disabled={saving || !input.trim()}
          className="min-h-[36px] px-2 text-[11px] font-mono bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Add
        </Button>
      </div>

      {error && (
        <p className="text-[11px] text-destructive font-mono">{error}</p>
      )}

      <div className="text-[10px] font-mono text-muted-foreground/40 mt-0.5">
        Press Enter to add · Backspace to remove last · Esc to close
      </div>
    </div>
  );
}

import { useState } from "react";
import { safeGetItem } from "../lib/utils";
import { withBase } from "../lib/createStackFetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { StackEditor } from "./StackEditor";
import type { StackSummary } from "../../types/stack-types.js";

interface StacksManagePageProps {
  stacks: StackSummary[];
  activeStackId: string;
  onSwitchStack: (stackId: string) => void;
  onRefetch: () => Promise<void>;
}

function healthDotColor(stack: StackSummary): string {
  const h = stack.healthSummary;
  if (!h || h.total === 0) return "bg-muted-foreground/30";
  if (h.down > 0) return "bg-destructive";
  if (h.degraded > 0) return "bg-warning";
  if (h.healthy === h.total) return "bg-success";
  return "bg-muted-foreground/30";
}

export function StacksManagePage({ stacks, activeStackId, onSwitchStack, onRefetch }: StacksManagePageProps) {
  const [mode, setMode] = useState<"list" | "create">("list");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StackSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const startRename = (stack: StackSummary) => {
    setRenamingId(stack.id);
    setRenameDraft(stack.name);
    setRenameError(null);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
    setRenameError(null);
  };

  const submitRename = async (stack: StackSummary) => {
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === stack.name) { cancelRename(); return; }
    setRenameSaving(true);
    setRenameError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const apiKey = safeGetItem("dops-api-key");
      if (apiKey) headers["X-API-Key"] = apiKey;
      const res = await fetch(withBase(`/api/stacks/${stack.id}`), {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `Failed to rename stack (${res.status})`);
      }
      await onRefetch();
      cancelRename();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Failed to rename");
    }
    setRenameSaving(false);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const headers: Record<string, string> = {};
      const apiKey = safeGetItem("dops-api-key");
      if (apiKey) headers["X-API-Key"] = apiKey;
      const res = await fetch(withBase(`/api/stacks/${deleteTarget.id}`), { method: "DELETE", headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `Failed to delete stack (${res.status})`);
      }
      if (deleteTarget.id === activeStackId) {
        const defaultStack = stacks.find((s) => s.isDefault && s.id !== deleteTarget.id);
        if (defaultStack) onSwitchStack(defaultStack.id);
      }
      await onRefetch();
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete");
    }
    setDeleting(false);
  };

  if (mode === "create") {
    return (
      <StackEditor
        onCancel={() => setMode("list")}
        onCreated={async (newStack) => {
          await onRefetch();
          onSwitchStack(newStack.id);
          setMode("list");
        }}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto relative z-[2]">
      {/* Title row */}
      <div className="mb-6 animate-fade-up flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90">Stacks</h1>
          <p className="text-xs font-mono text-muted-foreground/70 mt-1 tracking-wide">
            {stacks.length} stack{stacks.length !== 1 ? "s" : ""} configured
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setMode("create")}
          className="h-9 px-4 text-[12px] font-mono bg-primary/10 border-primary/20 text-primary hover:bg-primary/15 hover:text-primary rounded-lg gap-1.5 shrink-0"
        >
          <Plus size={12} className="!size-auto" />
          New Stack
        </Button>
      </div>

      {/* Stack cards */}
      <div className="max-w-4xl">
        <div className="grid gap-3 sm:grid-cols-2">
          {stacks.map((stack, i) => {
            const isRenaming = renamingId === stack.id;
            const isActive = stack.id === activeStackId;
            return (
              <div
                key={stack.id}
                className={`relative rounded-xl border p-4 transition-all border-border/40 bg-card/30 hover:border-primary/30 hover:bg-card/60 animate-fade-up delay-${Math.min(i + 1, 8)} ${
                  isActive ? "ring-1 ring-primary/20" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${healthDotColor(stack)}`} />
                    {isRenaming ? (
                      <input
                        type="text"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void submitRename(stack); }
                          if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                        }}
                        autoFocus
                        maxLength={64}
                        disabled={renameSaving}
                        className="font-display text-sm font-semibold text-foreground bg-secondary/40 border border-primary/30 rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-primary/30 min-w-0 flex-1"
                        aria-label={`Rename ${stack.name}`}
                      />
                    ) : (
                      <>
                        <h3 className="text-sm font-display font-semibold text-foreground/80 truncate">
                          {stack.name}
                        </h3>
                        {stack.isDefault && (
                          <Badge className="text-[9px] font-mono font-semibold uppercase py-0 h-4 bg-primary/8 text-primary border-0 shrink-0">
                            DEFAULT
                          </Badge>
                        )}
                        {isActive && !stack.isDefault && (
                          <Badge variant="secondary" className="text-[9px] font-mono py-0 h-4 shrink-0">
                            ACTIVE
                          </Badge>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {isRenaming ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void submitRename(stack)}
                          disabled={renameSaving || !renameDraft.trim()}
                          aria-label="Save rename"
                          className="h-7 px-2 text-primary hover:bg-primary/10"
                        >
                          {renameSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={cancelRename}
                          disabled={renameSaving}
                          aria-label="Cancel rename"
                          className="h-7 px-2 text-muted-foreground/60 hover:text-foreground hover:bg-muted/40"
                        >
                          <X size={12} />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startRename(stack)}
                          aria-label={`Rename ${stack.name}`}
                          className="h-7 px-2 text-muted-foreground/60 hover:text-foreground hover:bg-muted/40"
                        >
                          <Pencil size={12} />
                        </Button>
                        {!stack.isDefault && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteTarget(stack)}
                            aria-label={`Delete ${stack.name}`}
                            className="h-7 px-2 text-destructive/60 hover:text-destructive hover:bg-destructive/8"
                          >
                            <Trash2 size={12} />
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {isRenaming && renameError && (
                  <p className="font-mono text-[10px] text-destructive mt-1">{renameError}</p>
                )}
                {!isRenaming && (
                  <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-muted-foreground/50">
                    <span className="truncate">{stack.slug}</span>
                    <span className="shrink-0">
                      {stack.providerCount} provider{stack.providerCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteError(null); } }}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="font-display text-base font-semibold">
              Delete {deleteTarget?.name}?
            </DialogTitle>
            <DialogDescription className="font-body text-[13px] text-muted-foreground/70">
              This will permanently delete all investigations, messages, services, and provider
              configurations for this stack. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="font-mono text-[10px] text-destructive">{deleteError}</p>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => { setDeleteTarget(null); setDeleteError(null); }}
              disabled={deleting}
              className="font-mono text-xs"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
              className="font-mono text-xs"
            >
              {deleting ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete Stack"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

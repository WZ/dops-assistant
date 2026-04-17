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
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { CreateStackDialog } from "./CreateStackDialog";
import { RenameStackDialog } from "./RenameStackDialog";
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
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<StackSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StackSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
      // If we deleted the active stack, switch to default
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

  return (
    <div>
      {/* Stack cards */}
      <div className="space-y-2">
        {stacks.map((stack, i) => (
          <div
            key={stack.id}
            className={`flex items-center justify-between px-4 py-3 rounded-lg border border-border/40 bg-card/50 animate-fade-up delay-${Math.min(i + 1, 8)} ${
              stack.id === activeStackId ? "ring-1 ring-primary/20" : ""
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${healthDotColor(stack)}`} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-display text-sm font-semibold text-foreground truncate">
                    {stack.name}
                  </span>
                  {stack.isDefault && (
                    <Badge className="text-[9px] font-mono font-semibold uppercase py-0 h-4 bg-primary/8 text-primary border-0">
                      DEFAULT
                    </Badge>
                  )}
                  {stack.id === activeStackId && !stack.isDefault && (
                    <Badge variant="secondary" className="text-[9px] font-mono py-0 h-4">
                      ACTIVE
                    </Badge>
                  )}
                </div>
                <span className="font-mono text-[10px] text-muted-foreground/50">{stack.slug}</span>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="font-mono text-[10px] text-muted-foreground/50">
                {stack.providerCount} provider{stack.providerCount !== 1 ? "s" : ""}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRenameTarget(stack)}
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
            </div>
          </div>
        ))}
      </div>

      {/* Add stack action */}
      <div className="flex items-center gap-3 mt-3 pl-3">
        <button
          onClick={() => setCreateOpen(true)}
          className="text-[10px] font-mono text-primary/70 hover:text-primary transition-colors py-3 px-2 min-h-[44px]"
        >
          + Create Stack
        </button>
      </div>

      {/* Create dialog */}
      <CreateStackDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async (newStack) => {
          await onRefetch();
          onSwitchStack(newStack.id);
          setCreateOpen(false);
        }}
      />

      {/* Rename dialog */}
      <RenameStackDialog
        stack={renameTarget}
        onOpenChange={(open) => { if (!open) setRenameTarget(null); }}
        onRenamed={onRefetch}
      />

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

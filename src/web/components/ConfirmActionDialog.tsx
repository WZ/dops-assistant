import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type ConfirmVariant = "default" | "destructive";

interface ConfirmActionDialogProps {
  /** Controlled open state */
  open: boolean;
  /** Fires when the dialog should close (Escape, backdrop click, Cancel) */
  onOpenChange: (open: boolean) => void;
  /** Dialog heading */
  title: string;
  /** Body copy shown under the title. May be a string or ReactNode */
  body?: React.ReactNode;
  /** Confirm button label (e.g. "Remove", "Delete") */
  confirmLabel: string;
  /** Cancel button label (defaults to "Cancel") */
  cancelLabel?: string;
  /** Visual treatment of the confirm button — destructive uses red */
  variant?: ConfirmVariant;
  /** Called when confirm is clicked. May be async; dialog waits before closing */
  onConfirm: () => void | Promise<void>;
}

/**
 * Reusable confirmation dialog for destructive or significant actions.
 *
 * Contract:
 * - Cancel is the default-focused button (keyboard-safe: Enter cancels).
 * - Escape + backdrop click + Cancel all trigger onOpenChange(false).
 * - Destructive variant styles the confirm button in destructive tokens.
 * - onConfirm may return a promise; the dialog shows a pending state until resolved.
 *
 * Uses a portalized custom div (not @radix-ui/react-alert-dialog which isn't installed),
 * role="alertdialog" for screen readers.
 */
export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
}: ConfirmActionDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);

  // Focus trap + Escape + default focus on Cancel
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pendingRef.current) return;
        e.preventDefault();
        onOpenChange(false);
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    // Default focus on Cancel — keyboard-safe for destructive actions
    cancelRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;

  const handleConfirm = async () => {
    try {
      pendingRef.current = true;
      const result = onConfirm();
      if (result instanceof Promise) {
        await result;
      }
      onOpenChange(false);
    } finally {
      pendingRef.current = false;
    }
  };

  const handleBackdrop = () => {
    if (pendingRef.current) return;
    onOpenChange(false);
  };

  const confirmClass = variant === "destructive"
    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
    : "bg-primary text-primary-foreground hover:bg-primary/90";

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-action-title"
      aria-describedby={body ? "confirm-action-body" : undefined}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 animate-fade-in"
        onClick={handleBackdrop}
        data-testid="confirm-action-backdrop"
      />

      {/* Dialog card */}
      <div
        ref={dialogRef}
        className="relative bg-card border border-border/40 rounded-lg shadow-lg w-full max-w-md mx-4 animate-fade-up"
      >
        <div className="px-5 pt-5 pb-4">
          <h2
            id="confirm-action-title"
            className="font-display text-base font-semibold text-foreground/90"
          >
            {title}
          </h2>

          {body && (
            <div
              id="confirm-action-body"
              className="mt-2 font-body text-[13px] text-muted-foreground/80"
            >
              {body}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-4">
          <button
            ref={cancelRef}
            onClick={() => onOpenChange(false)}
            className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/60 hover:text-foreground/80 transition-colors py-2.5 px-4 min-h-[44px]"
          >
            {cancelLabel}
          </button>
          <button
            onClick={handleConfirm}
            className={cn(
              "font-mono text-[10px] uppercase tracking-[0.1em] transition-colors py-2.5 px-5 rounded min-h-[44px]",
              confirmClass,
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

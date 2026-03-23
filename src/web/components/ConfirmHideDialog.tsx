import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ConfirmHideDialogProps {
  /** Single service name or null for bulk mode */
  serviceName: string | null;
  /** Service names for bulk hide */
  serviceNames?: string[];
  /** Pre-filled reason (e.g. from auto-hide suggestion) */
  defaultReason?: string;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}

export function ConfirmHideDialog({ serviceName, serviceNames, defaultReason, onConfirm, onCancel }: ConfirmHideDialogProps) {
  const [reason, setReason] = useState(defaultReason ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const isBulk = serviceNames && serviceNames.length > 1;
  const count = isBulk ? serviceNames.length : 1;
  const displayName = isBulk ? `${count} services` : serviceName ?? "service";

  // Focus trap + Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
      // Simple focus trap: Tab cycles within dialog
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, textarea, [tabindex]:not([tabindex="-1"])'
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
    // Auto-focus reason textarea
    reasonRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to hide service");
      setLoading(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Hide ${displayName}`}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 animate-fade-in" onClick={onCancel} />

      {/* Dialog card */}
      <div
        ref={dialogRef}
        className="relative bg-card border border-border/40 rounded-lg shadow-lg w-full max-w-md mx-4 animate-fade-up"
      >
        <div className="px-5 pt-5 pb-4">
          <h2 className="font-display text-base font-semibold text-foreground/90">
            Hide {displayName}
          </h2>

          {isBulk && serviceNames && (
            <div className="mt-2 max-h-24 overflow-y-auto">
              <div className="flex flex-wrap gap-1">
                {serviceNames.map(name => (
                  <span key={name} className="font-mono text-[10px] text-muted-foreground/60 bg-secondary/50 rounded px-1.5 py-0.5">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {!isBulk && serviceName && (
            <p className="mt-1 font-mono text-[13px] text-foreground/70">{serviceName}</p>
          )}

          <p className="mt-3 font-body text-[13px] text-muted-foreground/70">
            {isBulk ? "These services" : "This service"} will be hidden from monitoring and investigations.
            You can unhide {isBulk ? "them" : "it"} later from the Hidden group.
          </p>

          <div className="mt-3">
            <label className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50" htmlFor="hide-reason">
              Reason (optional)
            </label>
            <textarea
              ref={reasonRef}
              id="hide-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you hiding this?"
              rows={2}
              className="mt-1 w-full font-mono text-xs text-foreground/70 bg-secondary/30 border border-border/40 rounded px-3 py-2 resize-none focus:border-primary/30 focus:outline-none placeholder:text-muted-foreground/40"
            />
          </div>

          {error && (
            <p className="mt-2 font-body text-[12px] text-destructive">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-4">
          <button
            onClick={onCancel}
            disabled={loading}
            className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/60 hover:text-foreground/80 transition-colors py-2.5 px-4 min-h-[44px]"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="font-mono text-[10px] uppercase tracking-[0.1em] bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors py-2.5 px-5 rounded min-h-[44px] disabled:opacity-50"
          >
            {loading ? "Hiding\u2026" : `Hide ${isBulk ? `${count} services` : ""}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

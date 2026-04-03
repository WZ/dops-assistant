import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface ToastItem {
  id: string;
  service: string;
  status: "complete" | "failed" | "hidden" | "unhidden";
  timestamp: number;
}

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  onClickToast: (id: string) => void;
}

function Toast({ toast, onDismiss, onClick }: { toast: ToastItem; onDismiss: () => void; onClick: () => void }) {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pausedRef = useRef(false);

  const startTimer = useCallback(() => {
    timerRef.current = setTimeout(() => {
      setExiting(true);
      setTimeout(onDismiss, 250); // match fade-out duration
    }, 8000);
  }, [onDismiss]);

  useEffect(() => {
    startTimer();
    return () => clearTimeout(timerRef.current);
  }, [startTimer]);

  const handleMouseEnter = () => {
    pausedRef.current = true;
    clearTimeout(timerRef.current);
  };

  const handleMouseLeave = () => {
    pausedRef.current = false;
    startTimer();
  };

  return (
    <div
      role="alert"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={toast.status === "hidden" || toast.status === "unhidden" ? undefined : onClick}
      className={`${toast.status !== "hidden" && toast.status !== "unhidden" ? "cursor-pointer" : ""} max-w-[320px] rounded-lg border bg-card p-3 transition-all ${
        toast.status === "complete" ? "border-success/25 glow-green" :
        toast.status === "failed" ? "border-destructive/25 glow-red" :
        "border-border"
      } ${exiting ? "opacity-0 translate-x-3" : "animate-slide-in-right"}`}
      style={{
        boxShadow: toast.status === "complete" || toast.status === "failed"
          ? undefined  // glow classes handle shadow
          : "0 8px 24px hsl(var(--foreground) / 0.08)",
        transitionDuration: exiting ? "250ms" : undefined,
      }}
    >
      <div className="flex items-start gap-2.5">
        {(toast.status === "hidden" || toast.status === "unhidden") ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mt-1 flex-shrink-0 text-muted-foreground/60">
            {toast.status === "hidden" ? (
              <>
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </>
            ) : (
              <>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </>
            )}
          </svg>
        ) : (
          <div className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            toast.status === "complete" ? "bg-success" : "bg-destructive"
          }`} />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-body text-[13px] font-semibold text-foreground/80 truncate">{toast.service}</p>
          <p className="font-mono text-[10px] text-muted-foreground/60">
            {toast.status === "hidden" ? "hidden from monitoring"
              : toast.status === "unhidden" ? "monitoring resumed"
              : toast.status === "complete" ? "Root cause identified — click to view"
              : "Investigation failed — click to view"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => { e.stopPropagation(); setExiting(true); setTimeout(onDismiss, 250); }}
          className="flex-shrink-0 h-auto w-auto p-1 text-muted-foreground/40 hover:text-muted-foreground/70 hover:bg-transparent"
          aria-label="Dismiss"
        >
          <X size={12} className="!size-auto" />
        </Button>
      </div>
    </div>
  );
}

export const ToastContainer = memo(function ToastContainer({ toasts, onDismiss, onClickToast }: ToastContainerProps) {
  // Only show the last 3
  const visible = toasts.slice(-3);

  if (visible.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2" role="log" aria-label="Notifications">
      {visible.map(toast => (
        <Toast
          key={toast.id}
          toast={toast}
          onDismiss={() => onDismiss(toast.id)}
          onClick={() => onClickToast(toast.id)}
        />
      ))}
    </div>
  );
});

export type { ToastItem };

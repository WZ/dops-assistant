import { memo, useEffect, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProviderToolList, type ToolInfo } from "./ProviderToolList";
import { useStackContext } from "../../contexts/StackContext";

export interface TestResult {
  status: "ok" | "error";
  toolCount: number;
  error?: string;
}

interface ProviderCardProps {
  name: string;
  roles: string[];
  region?: string;
  transport: string;
  command?: string;
  url?: string;
  source: "config" | "gui";
  status: "connected" | "error" | "unknown";
  toolCount: number;
  enabledToolCount?: number;
  error?: string;
  onTest: () => void;
  onEdit?: () => void;
  onRemove?: () => void;
  testing?: boolean;
  testResult?: TestResult | null;
}

export const ProviderCard = memo(function ProviderCard({
  name,
  roles,
  region,
  transport,
  command,
  url,
  source,
  status,
  toolCount,
  enabledToolCount,
  error,
  onTest,
  onEdit,
  onRemove,
  testing = false,
  testResult = null,
}: ProviderCardProps) {
  // Auto-dismiss test result after 6s
  const [visibleResult, setVisibleResult] = useState<TestResult | null>(null);
  useEffect(() => {
    if (!testResult) { setVisibleResult(null); return; }
    setVisibleResult(testResult);
    const t = setTimeout(() => setVisibleResult(null), 6000);
    return () => clearTimeout(t);
  }, [testResult]);
  const statusDotClass = testing
    ? "w-2 h-2 rounded-full bg-primary animate-status-pulse"
    : status === "connected"
      ? "w-2 h-2 rounded-full bg-success ring-2 ring-success/25"
      : status === "error"
        ? "w-2 h-2 rounded-full bg-destructive ring-2 ring-destructive/25"
        : "w-2 h-2 rounded-full bg-muted-foreground/40";

  const transportLabel = command
    ? `${command} (${transport})`
    : url
      ? `${url} (${transport})`
      : transport;

  const accessibilityStatus = testing
    ? "testing"
    : status === "connected"
      ? "connected"
      : status === "error"
        ? "error"
        : "unknown";

  const ariaLabel = `${name}: ${accessibilityStatus}, ${toolCount} tools`;

  const actionButtonClass =
    "text-[10px] font-mono no-underline hover:no-underline h-auto py-3 px-2 min-h-[44px]";

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="rounded-lg border border-border/40 bg-card/50 hover:bg-card/80 hover:border-primary/25 px-4 py-3 transition-all card-lift"
    >
      {/* Header row: status dot + name + badges */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={cn("shrink-0 mt-[3px]", statusDotClass)} />
          <span className="font-body text-sm font-medium text-foreground/90 truncate">
            {name}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
          {source === "config" && (
            <Badge variant="secondary" className="text-[10px] py-0 h-4 uppercase">
              SYSTEM
            </Badge>
          )}
          {roles.map((role) => (
            <Badge
              key={role}
              variant="outline"
              className="text-[10px] py-0 h-4 uppercase"
            >
              {role}
            </Badge>
          ))}
        </div>
      </div>

      {/* Transport info */}
      <div className="mt-1 pl-[18px]">
        <span className="font-mono text-[10px] text-muted-foreground/60 break-all">
          {transportLabel}
        </span>
      </div>

      {/* Tool count */}
      <div className="mt-0.5 pl-[18px]">
        <span className="font-mono text-[10px] text-muted-foreground/50">
          {toolCount} tools{enabledToolCount != null ? ` (${enabledToolCount} enabled)` : ""}
        </span>
      </div>

      {/* Error message (persistent, from registry status) */}
      {status === "error" && error && !visibleResult && (
        <div className="mt-0.5 pl-[18px]">
          <span className="text-xs text-destructive/70">{error}</span>
        </div>
      )}

      {/* Test result (transient, auto-dismisses after 6s) */}
      {visibleResult && (
        <div className="mt-1 pl-[18px]">
          {visibleResult.status === "ok" ? (
            <span className="font-mono text-[10px] text-success font-medium">
              OK &mdash; {visibleResult.toolCount} tools available
            </span>
          ) : (
            <span className="font-mono text-[10px] text-destructive/80 font-medium">
              FAILED{visibleResult.error ? ` — ${visibleResult.error}` : ""}
            </span>
          )}
        </div>
      )}

      {/* Region */}
      {region && (
        <div className="mt-0.5 pl-[18px]">
          <span className="font-mono text-[10px] text-muted-foreground/50">{region}</span>
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-1 pl-[10px] flex items-center gap-0">
        {source === "gui" && onEdit && (
          <Button
            variant="link"
            onClick={onEdit}
            aria-label={`Edit ${name}`}
            className={cn(actionButtonClass, "text-primary/70 hover:text-primary")}
          >
            Edit
          </Button>
        )}
        <Button
          variant="link"
          onClick={onTest}
          disabled={testing}
          aria-label={`Test connection for ${name}`}
          className={cn(actionButtonClass, "text-primary/70 hover:text-primary", testing && "opacity-50 cursor-not-allowed")}
        >
          {testing ? "Testing\u2026" : "Test"}
        </Button>
        {source === "gui" && onRemove && (
          <Button
            variant="link"
            onClick={onRemove}
            aria-label={`Remove ${name}`}
            className={cn(actionButtonClass, "text-destructive/60 hover:text-destructive")}
          >
            Remove
          </Button>
        )}
      </div>
      <ToolsSection name={name} source={source} toolCount={toolCount} />
    </div>
  );
});

function ToolsSection({ name, source, toolCount }: { name: string; source: "config" | "gui"; toolCount: number }) {
  const { stackFetch } = useStackContext();
  const [expanded, setExpanded] = useState(false);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [loaded, setLoaded] = useState(false);

  const handleExpand = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !loaded) {
      try {
        const res = await stackFetch(`/api/providers/${encodeURIComponent(name)}/tools`);
        if (res.ok) setTools(await res.json());
        else setTools([]);
      } catch { setTools([]); }
      setLoaded(true);
    }
  }, [expanded, loaded, name, stackFetch]);

  const handleUpdate = useCallback(async (enabledTools: string[]) => {
    const res = await stackFetch(`/api/providers/${encodeURIComponent(name)}/tools`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabledTools }),
    });
    if (!res.ok) throw new Error("Save failed");
    const refreshRes = await stackFetch(`/api/providers/${encodeURIComponent(name)}/tools`);
    if (refreshRes.ok) setTools(await refreshRes.json());
  }, [name, stackFetch]);

  if (toolCount === 0) return null;

  return (
    <div className="mt-2 pt-2 border-t border-border/20">
      <button
        onClick={handleExpand}
        className="flex items-center gap-2 w-full text-left"
        aria-expanded={expanded}
      >
        <div className="w-0.5 h-3 bg-primary rounded-full" />
        <span className="text-[9px] font-mono font-semibold uppercase tracking-[0.12em] text-muted-foreground/50 flex-1">
          Tools
        </span>
        <ChevronDown
          size={12}
          className={`text-muted-foreground/40 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <ProviderToolList tools={tools} providerName={name} source={source} onUpdate={handleUpdate} />
      )}
    </div>
  );
}

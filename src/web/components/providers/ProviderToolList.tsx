import { useState, useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Lock } from "lucide-react";

export interface ToolInfo {
  name: string;
  description: string;
  readOnly: boolean;
  enabled: boolean;
}

interface ProviderToolListProps {
  tools: ToolInfo[] | null;
  providerName: string;
  source: "config" | "gui";
  onUpdate: (enabledTools: string[]) => Promise<void>;
}

export function ProviderToolList({ tools, providerName, source, onUpdate }: ProviderToolListProps) {
  const [saving, setSaving] = useState<string | null>(null);
  const [errorTool, setErrorTool] = useState<string | null>(null);

  const handleToggle = useCallback(async (toolName: string, currentlyEnabled: boolean) => {
    if (!tools) return;
    setSaving(toolName);
    setErrorTool(null);
    const currentEnabled = tools.filter(t => t.enabled).map(t => t.name);
    const newEnabled = currentlyEnabled
      ? currentEnabled.filter(n => n !== toolName)
      : [...currentEnabled, toolName];
    try {
      await onUpdate(newEnabled);
    } catch {
      setErrorTool(toolName);
    } finally {
      setSaving(null);
    }
  }, [tools, onUpdate]);

  const handleEnableAllReadOnly = useCallback(async () => {
    if (!tools) return;
    const readOnlyNames = tools.filter(t => t.readOnly).map(t => t.name);
    const writeEnabled = tools.filter(t => !t.readOnly && t.enabled).map(t => t.name);
    await onUpdate([...readOnlyNames, ...writeEnabled]);
  }, [tools, onUpdate]);

  const handleDisableAll = useCallback(async () => {
    await onUpdate([]);
  }, [onUpdate]);

  if (tools === null) {
    return (
      <div className="space-y-2 mt-2" data-testid="tool-list-loading">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}
      </div>
    );
  }

  const sorted = [...tools].sort((a, b) => {
    if (a.readOnly !== b.readOnly) return a.readOnly ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2" role="note">
        <Lock size={12} className="text-primary/60 mt-0.5 shrink-0" />
        <p className="font-mono text-[10px] text-foreground/60 leading-relaxed">
          Only read-only tools are enabled by default. Write tools require explicit opt-in to prevent accidental modifications to your infrastructure.
        </p>
      </div>

      <div className="flex items-center justify-end gap-3">
        <button onClick={handleEnableAllReadOnly} className="text-[10px] font-mono text-primary/60 hover:text-primary transition-colors">
          Enable all read-only
        </button>
        <button onClick={handleDisableAll} className="text-[10px] font-mono text-muted-foreground/50 hover:text-muted-foreground transition-colors">
          Disable all
        </button>
      </div>

      {sorted.map(tool => (
        <div key={tool.name} className="flex items-start gap-3 py-1.5">
          <Switch
            checked={tool.enabled}
            onCheckedChange={() => handleToggle(tool.name, tool.enabled)}
            disabled={saving === tool.name}
            aria-label={`Toggle ${tool.name}`}
            className="mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span data-testid="tool-name" className="font-mono text-[11px] text-foreground/80 truncate">{tool.name}</span>
              <Badge
                variant="outline"
                className={`text-[9px] py-0 h-4 uppercase ${
                  tool.readOnly
                    ? "bg-success/10 text-success border-success/20"
                    : "bg-warning/10 text-warning border-warning/20"
                }`}
              >
                {tool.readOnly ? "READ" : "WRITE"}
              </Badge>
              <span className={`text-[10px] ${tool.enabled ? "text-success" : "text-muted-foreground/30"}`}>
                {tool.enabled ? "●" : "○"}
              </span>
            </div>
            {tool.description && (
              <p className="text-[10px] text-muted-foreground/60 mt-0.5 truncate">{tool.description}</p>
            )}
            {errorTool === tool.name && saving === null && (
              <p className="text-[10px] text-destructive/70 mt-0.5">Couldn&apos;t save — try again?</p>
            )}
          </div>
        </div>
      ))}

      {source === "config" && (
        <p className="text-[9px] font-mono text-muted-foreground/40 mt-2 italic">
          Changes to system providers are in-memory only. Update config.yaml to persist.
        </p>
      )}
    </div>
  );
}

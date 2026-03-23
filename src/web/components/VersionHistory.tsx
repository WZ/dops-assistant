import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import type { ServiceRegistryVersion } from "../../types/discovery-types.js";

interface VersionHistoryProps {
  onBack: () => void;
}

export function VersionHistory({ onBack }: VersionHistoryProps) {
  const [versions, setVersions] = useState<ServiceRegistryVersion[]>([]);

  useEffect(() => {
    fetch("/api/services/versions")
      .then((r) => r.json())
      .then(setVersions)
      .catch(() => {});
  }, []);

  const handleRestore = async (id: string) => {
    const res = await fetch(`/api/services/versions/${id}/restore`, { method: "POST" });
    if (res.ok) {
      const updated = await fetch("/api/services/versions").then((r) => r.json());
      setVersions(updated);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="text-xs text-muted-foreground/50 mb-4">
        <span className="text-muted-foreground/70">Dashboard</span>
        <span className="mx-1.5">{"\u203A"}</span>
        <Button variant="link" className="text-primary h-auto p-0 text-xs" onClick={onBack}>Services</Button>
        <span className="mx-1.5">{"\u203A"}</span>
        <span>History</span>
      </div>

      <h2 className="font-semibold text-sm mb-4">Version History</h2>

      <div className="space-y-2">
        {versions.length === 0 && (
          <p className="text-sm text-muted-foreground/70">No version history yet</p>
        )}
        {versions.map((v, i) => (
          <div key={v.id} className="rounded-lg border bg-card/40 overflow-hidden">
            <div className="flex items-center px-4 py-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">v{versions.length - i}</span>
                  {i === versions.length - 1 && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-primary/10 text-primary">current</span>
                  )}
                  <span className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground">{v.source}</span>
                </div>
                <div className="text-[11px] text-muted-foreground/70 mt-1">
                  {new Date(v.timestamp).toLocaleString()} {"\u00B7"} {v.serviceCount} services
                </div>
              </div>
              {i < versions.length - 1 && (
                <Button
                  onClick={() => handleRestore(v.id)}
                  variant="outline"
                  size="sm"
                  className="text-[11px] text-warning"
                >
                  Restore
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

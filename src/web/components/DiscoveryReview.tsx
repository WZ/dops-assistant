import { useEffect, useMemo, useState } from "react";
import { stringify, parse } from "yaml";
import { Button } from "@/components/ui/button";
import { YamlEditor } from "./YamlEditor.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { ServiceConfig } from "../../config/schema.js";

interface DiscoveryReviewProps {
  services: ValidatedServiceConfig[];
  onAccept: (services: ServiceConfig[]) => void;
  onReject: () => void;
  onRerun: () => void;
  onBack: () => void;
}

export function DiscoveryReview({ services: initialServices, onAccept, onReject, onRerun, onBack }: DiscoveryReviewProps) {
  const [services, setServices] = useState(initialServices);
  const [showEditor, setShowEditor] = useState(false);
  const [yamlValue, setYamlValue] = useState(() => {
    const stripped = initialServices.map(({ confidence: _c, validationNotes: _v, ...s }) => s);
    return stringify(stripped, { indent: 2 });
  });

  const [currentServices, setCurrentServices] = useState<ServiceConfig[]>([]);

  useEffect(() => {
    fetch("/api/services")
      .then(r => r.ok ? r.json() : [])
      .then(data => { if (Array.isArray(data)) setCurrentServices(data); })
      .catch(() => {});
  }, []);

  const diff = useMemo(() => {
    const currentNames = new Set(currentServices.map(s => s.name));
    const discoveredNames = new Set(services.map(s => s.name));
    const added = services.filter(s => !currentNames.has(s.name)).length;
    const removed = currentServices.filter(s => !discoveredNames.has(s.name)).length;
    const unchanged = services.filter(s => currentNames.has(s.name)).length;
    return { added, removed, unchanged };
  }, [services, currentServices]);

  const verified = services.filter((s) => s.confidence === "verified").length;
  const partial = services.filter((s) => s.confidence === "partial").length;
  const unverified = services.filter((s) => s.confidence === "unverified").length;

  const handleFilter = () => {
    const filtered = services.filter((s) => s.confidence !== "unverified");
    setServices(filtered);
    const stripped = filtered.map(({ confidence: _c, validationNotes: _v, ...s }) => s);
    setYamlValue(stringify(stripped, { indent: 2 }));
  };

  const handleAccept = () => {
    try {
      const parsed = parse(yamlValue);
      if (Array.isArray(parsed)) {
        onAccept(parsed);
        return;
      }
    } catch { /* fall through */ }
    onAccept(services.map(({ confidence: _c, validationNotes: _v, ...s }) => s));
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="text-xs text-muted-foreground/50 mb-4">
        <Button variant="link" className="text-primary h-auto p-0 text-xs" onClick={onBack}>Dashboard</Button>
        <span className="mx-1.5">{"\u203A"}</span>
        <span>Services</span>
        <span className="mx-1.5">{"\u203A"}</span>
        <span>Review</span>
      </div>

      <div className="rounded-lg border bg-card/40 p-4 mb-4">
        <h3 className="font-semibold text-sm mb-3">Discovery Complete</h3>
        {currentServices.length > 0 && (
          <div className="flex items-center gap-3 mb-3 font-mono text-[11px]">
            {diff.added > 0 && <span className="text-success/70">+{diff.added} new</span>}
            {diff.removed > 0 && <span className="text-destructive/70">&minus;{diff.removed} removed</span>}
            {diff.unchanged > 0 && <span className="text-muted-foreground/50">{diff.unchanged} unchanged</span>}
            {diff.added === 0 && diff.removed === 0 && <span className="text-muted-foreground/50">no changes from current registry</span>}
          </div>
        )}
        <div className="flex gap-6 text-center">
          <div>
            <div className="text-2xl font-bold">{services.length}</div>
            <div className="text-[10px] text-muted-foreground/50">services found</div>
          </div>
          <div className="w-px bg-border" />
          <div>
            <div className="text-2xl font-bold text-success">{verified}</div>
            <div className="text-[10px] text-muted-foreground/50">verified</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-warning">{partial}</div>
            <div className="text-[10px] text-muted-foreground/50">partial</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-destructive">{unverified}</div>
            <div className="text-[10px] text-muted-foreground/50">unverified</div>
          </div>
        </div>

        {/* Service table */}
        <div className="mt-3 bg-background/50 rounded overflow-hidden">
          <div className="grid grid-cols-[1fr_60px_80px_50px] px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 border-b border-border/30">
            <span>Service</span>
            <span className="text-right">Metrics</span>
            <span className="text-right">Log Labels</span>
            <span className="text-right">Status</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {services.map((s) => (
              <div
                key={s.name}
                className="grid grid-cols-[1fr_60px_80px_50px] px-3 py-1.5 text-xs border-b border-border/10 hover:bg-accent/20"
              >
                <span className="font-mono font-medium truncate">{s.name}</span>
                <span className="text-muted-foreground/60 text-right">{s.metrics?.length ?? 0}</span>
                <span className="text-muted-foreground/60 text-right">{Object.keys(s.logLabels ?? {}).length}</span>
                <span className={`text-right ${
                  s.confidence === "verified" ? "text-success" :
                  s.confidence === "partial" ? "text-warning" : "text-destructive"
                }`}>
                  {s.confidence === "verified" ? "✓" : s.confidence === "partial" ? "~" : "?"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card/40 overflow-hidden mb-4">
        <Button
          variant="ghost"
          onClick={() => setShowEditor(!showEditor)}
          className="flex items-center w-full px-4 py-2.5 h-auto text-left border-b rounded-none hover:bg-accent/50"
        >
          <span className="text-primary mr-2">{showEditor ? "\u25BE" : "\u25B8"}</span>
          <span className="text-sm flex-1">Edit YAML</span>
          <span className="text-[10px] text-muted-foreground/70">Click to expand and edit before accepting</span>
        </Button>
        {showEditor && (
          <div className="max-h-80 overflow-y-auto">
            <YamlEditor value={yamlValue} onChange={setYamlValue} />
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button
          onClick={handleAccept}
          variant="success"
          className="font-semibold"
        >
          Accept
        </Button>
        <Button
          onClick={onReject}
          variant="outline"
          className="text-destructive"
        >
          Reject
        </Button>
        <Button
          onClick={handleFilter}
          variant="outline"
        >
          Filter Unverified
        </Button>
        <Button
          onClick={onRerun}
          variant="outline"
        >
          Re-run
        </Button>
      </div>
    </div>
  );
}
